import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { MixControl } from "./mix-control";

const WAVEFORM_SAMPLES = 512;
/** Seconds of audio visible across one viewport width at 1× playback. */
const REFERENCE_LOOP_SECONDS = 10;

const BASE_SPEED_PX_S = 0;
const MIN_SPEED_PX_S = -600;
const MAX_SPEED_PX_S = 600;
const RETURN_RATE = 0;
const MIN_PLAY_SPEED_PX_S = 8;
const PLAYBACK_RATES = [.25, .5, 1, 1.5, 2, 3, 4] as const;
/** Seconds behind the leader playhead (tape echo taps). */
const TAPE_DELAY_SECONDS = [0.2, 0.4, 0.65] as const;
const ALL_TAPE_DELAYS = [0, ...TAPE_DELAY_SECONDS] as const;

type PlaybackDirection = "forward" | "reverse";

type SourceMeta = {
  direction: PlaybackDirection;
  rate: number;
  startedAt: number;
  bufferOffset: number;
  delaySeconds: number;
};

type PlaybackVoice = {
  source: AudioBufferSourceNode;
  gainNode: GainNode;
  meta: SourceMeta;
};

type DecodedAudio = {
  peaks: Float32Array;
  forwardBuffer: AudioBuffer;
  reversedBuffer: AudioBuffer;
  duration: number;
};

function wrapOffset(value: number, loop: number) {
  if (loop <= 0) return value;
  return ((value % loop) + loop) % loop;
}

function loopWidthForDuration(viewportWidth: number, duration: number) {
  if (viewportWidth <= 0) return 0;
  if (duration <= 0) return viewportWidth;
  return viewportWidth * (duration / REFERENCE_LOOP_SECONDS);
}

function pixelsPerSecondAt1x(viewportWidth: number, duration: number) {
  if (viewportWidth <= 0 || duration <= 0) return 0;
  return viewportWidth / REFERENCE_LOOP_SECONDS;
}

function offsetToTime(
  offset: number,
  loopWidth: number,
  duration: number,
  viewportWidth: number,
) {
  if (loopWidth <= 0 || duration <= 0 || viewportWidth <= 0) return 0;
  return (
    (wrapOffset(offset + viewportWidth / 2, loopWidth) / loopWidth) * duration
  );
}

function timeToOffset(
  time: number,
  loopWidth: number,
  duration: number,
  viewportWidth: number,
) {
  if (loopWidth <= 0 || duration <= 0 || viewportWidth <= 0) return 0;
  return wrapOffset(
    (time / duration) * loopWidth - viewportWidth / 2,
    loopWidth,
  );
}

function speedToPlaybackRate(
  speedPxS: number,
  viewportWidth: number,
  duration: number,
) {
  const pxPerSecond = pixelsPerSecondAt1x(viewportWidth, duration);
  if (pxPerSecond <= 0) return 1;
  return Math.abs(speedPxS) / pxPerSecond;
}

function quantizePlaybackRate(signedRate: number) {
  if (signedRate === 0) return 0;

  const sign = Math.sign(signedRate);
  const absRate = Math.abs(signedRate);
  let nearest: (typeof PLAYBACK_RATES)[number] = PLAYBACK_RATES[0];
  let minDiff = Math.abs(absRate - nearest);

  for (const candidate of PLAYBACK_RATES) {
    const diff = Math.abs(absRate - candidate);
    if (diff < minDiff) {
      minDiff = diff;
      nearest = candidate;
    }
  }

  return sign * nearest;
}

function quantizeFromSpeed(
  speedPxS: number,
  viewportWidth: number,
  duration: number,
) {
  if (Math.abs(speedPxS) < MIN_PLAY_SPEED_PX_S) return 0;
  const rawRate = speedToPlaybackRate(speedPxS, viewportWidth, duration);
  return quantizePlaybackRate(speedPxS > 0 ? rawRate : -rawRate);
}

function playbackRateToSpeed(
  signedRate: number,
  viewportWidth: number,
  duration: number,
) {
  if (signedRate === 0) return 0;
  const pxPerSecond = pixelsPerSecondAt1x(viewportWidth, duration);
  if (pxPerSecond <= 0) return 0;
  return signedRate * pxPerSecond;
}

function formatPlaybackRate(rate: number) {
  if (rate === 0) return "0×";
  return `${rate}×`;
}

function tapeDelayHeadLeft(
  delaySeconds: number,
  direction: PlaybackDirection,
) {
  const offsetPercent = (delaySeconds / REFERENCE_LOOP_SECONDS) * 100;
  const operator = direction === "reverse" ? "+" : "-";
  return `calc(50% ${operator} ${offsetPercent}%)`;
}

function wrapTime(time: number, duration: number) {
  if (duration <= 0) return 0;
  return ((time % duration) + duration) % duration;
}

function wrapLoopTime(time: number, loopStart: number, duration: number) {
  if (duration <= 0) return 0;
  if (loopStart <= 0) return wrapTime(time, duration);
  if (duration <= loopStart) return loopStart;
  const span = duration - loopStart;
  return loopStart + (((time - loopStart) % span) + span) % span;
}

function followerPlayhead(
  leaderTime: number,
  delaySeconds: number,
  direction: PlaybackDirection,
  loopStart: number,
  duration: number,
) {
  if (delaySeconds === 0) return wrapLoopTime(leaderTime, loopStart, duration);
  if (direction === "forward") {
    return wrapLoopTime(leaderTime - delaySeconds, loopStart, duration);
  }
  return wrapLoopTime(leaderTime + delaySeconds, loopStart, duration);
}

function playheadToBufferOffset(
  playhead: number,
  direction: PlaybackDirection,
  duration: number,
) {
  return direction === "forward"
    ? playhead
    : Math.max(0, duration - playhead);
}

function voiceGainForDelay(delaySeconds: number, wet: number) {
  if (delaySeconds === 0) return 1;
  const index = TAPE_DELAY_SECONDS.indexOf(
    delaySeconds as (typeof TAPE_DELAY_SECONDS)[number],
  );
  const tap = index >= 0 ? index + 1 : 1;
  return (1 / tap) * wet;
}

function peaksFromBuffer(buffer: AudioBuffer) {
  const channel = buffer.getChannelData(0);
  const blockSize = Math.max(1, Math.floor(channel.length / WAVEFORM_SAMPLES));
  const peaks = new Float32Array(WAVEFORM_SAMPLES);

  for (let i = 0; i < WAVEFORM_SAMPLES; i++) {
    const start = i * blockSize;
    let peak = 0;

    for (let j = 0; j < blockSize; j++) {
      peak = Math.max(peak, Math.abs(channel[start + j] ?? 0));
    }

    peaks[i] = peak;
  }

  return peaks;
}

function reverseBuffer(buffer: AudioBuffer, context: AudioContext) {
  const reversed = context.createBuffer(
    buffer.numberOfChannels,
    buffer.length,
    buffer.sampleRate,
  );

  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const input = buffer.getChannelData(channel);
    const output = reversed.getChannelData(channel);

    for (let i = 0, j = input.length - 1; i < input.length; i++, j--) {
      output[i] = input[j] ?? 0;
    }
  }

  return reversed;
}

async function decodeAudio(src: string): Promise<DecodedAudio> {
  const response = await fetch(src);
  const arrayBuffer = await response.arrayBuffer();
  const context = new AudioContext();
  const forwardBuffer = await context.decodeAudioData(arrayBuffer);
  const reversedBuffer = reverseBuffer(forwardBuffer, context);
  const peaks = peaksFromBuffer(forwardBuffer);

  await context.close();

  return {
    peaks,
    forwardBuffer,
    reversedBuffer,
    duration: forwardBuffer.duration,
  };
}

function drawWaveform(
  canvas: HTMLCanvasElement,
  peaks: Float32Array,
  cssWidth: number,
) {
  const dpr = window.devicePixelRatio || 1;
  const cssHeight = canvas.offsetHeight;
  const width = Math.max(1, Math.floor(cssWidth * dpr));
  const height = Math.max(1, Math.floor(cssHeight * dpr));

  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = getComputedStyle(canvas).color;

  const mid = height / 2;
  const barWidth = width / peaks.length;

  for (let i = 0; i < peaks.length; i++) {
    const amplitude = peaks[i] ?? 0;
    const barHeight = Math.max(dpr, amplitude * mid * 0.92);
    const x = i * barWidth;
    ctx.fillRect(x, mid - barHeight, Math.max(dpr, barWidth * 0.9), barHeight * 2);
  }
}

export type SliderHandle = {
  resetToLoopStart: () => void;
};

export type SliderProps = {
  audioRef: React.RefObject<HTMLAudioElement | null>;
  defaultSpeed?: number;
  defaultDelay?: number;
  defaultVolume?: number;
  defaultPan?: number;
};

export const Slider = forwardRef<SliderHandle, SliderProps>(function Slider(
  {
    audioRef,
    defaultSpeed = 0,
    defaultDelay = 1,
    defaultVolume = 1,
    defaultPan = 0,
  },
  ref,
) {
  const initialDirection: PlaybackDirection =
    defaultSpeed < 0 ? "reverse" : "forward";
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const [trackDuration, setTrackDuration] = useState(0);
  const [segmentWidth, setSegmentWidth] = useState(0);
  const [loopStartTime, setLoopStartTime] = useState(0);
  const [displayRate, setDisplayRate] = useState(defaultSpeed);
  const [headEngaged, setHeadEngaged] = useState(false);
  const [playbackDirection, setPlaybackDirection] =
    useState<PlaybackDirection>(initialDirection);
  const [volume, setVolume] = useState(defaultVolume);
  const [pan, setPan] = useState(defaultPan);
  const [wet, setWet] = useState(defaultDelay);
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const canvasARef = useRef<HTMLCanvasElement>(null);
  const canvasBRef = useRef<HTMLCanvasElement>(null);
  const peaksRef = useRef<Float32Array | null>(null);
  const forwardBufferRef = useRef<AudioBuffer | null>(null);
  const reversedBufferRef = useRef<AudioBuffer | null>(null);
  const durationRef = useRef(0);
  const loopStartRef = useRef(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const pannerRef = useRef<StereoPannerNode | null>(null);
  const volumeRef = useRef(defaultVolume);
  const panRef = useRef(defaultPan);
  const wetRef = useRef(defaultDelay);
  const voicesRef = useRef<PlaybackVoice[]>([]);
  const offsetRef = useRef(0);
  const speedRef = useRef(BASE_SPEED_PX_S);
  const playbackRateRef = useRef(defaultSpeed);
  const headEngagedRef = useRef(false);
  const loopWidthRef = useRef(0);
  const viewportWidthRef = useRef(0);
  const defaultsAppliedRef = useRef(false);
  const draggingRef = useRef(false);
  const lastPointerStartRef = useRef({ x: 0, t: 0 });
  const lastPointerRef = useRef({ x: 0, t: 0 });
  const reducedMotionRef = useRef(false);

  const applyMix = useCallback(() => {
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = volumeRef.current;
    }
    if (pannerRef.current) {
      pannerRef.current.pan.value = panRef.current;
    }
  }, []);

  const ensureAudioContext = useCallback(async () => {
    if (!audioContextRef.current) {
      const context = new AudioContext();
      const gain = context.createGain();
      const panner = context.createStereoPanner();

      gain.gain.value = volumeRef.current;
      panner.pan.value = panRef.current;
      gain.connect(panner);
      panner.connect(context.destination);

      audioContextRef.current = context;
      gainNodeRef.current = gain;
      pannerRef.current = panner;
    }

    if (audioContextRef.current.state === "suspended") {
      await audioContextRef.current.resume();
    }
  }, []);

  const handleVolumeChange = useCallback(
    (value: number) => {
      volumeRef.current = value;
      setVolume(value);
      applyMix();
    },
    [applyMix],
  );

  const handlePanChange = useCallback(
    (value: number) => {
      panRef.current = value;
      setPan(value);
      applyMix();
    },
    [applyMix],
  );

  const applyWet = useCallback(() => {
    const wetAmount = wetRef.current;
    for (const voice of voicesRef.current) {
      voice.gainNode.gain.value = voiceGainForDelay(
        voice.meta.delaySeconds,
        wetAmount,
      );
    }
  }, []);

  const handleWetChange = useCallback(
    (value: number) => {
      wetRef.current = value;
      setWet(value);
      applyWet();
    },
    [applyWet],
  );

  const stopPlayback = useCallback(() => {
    for (const voice of voicesRef.current) {
      try {
        voice.source.stop();
      } catch {
        // already stopped
      }
      voice.source.disconnect();
      voice.gainNode.disconnect();
    }
    voicesRef.current = [];
  }, []);

  const getMasterMeta = () =>
    voicesRef.current.find((voice) => voice.meta.delaySeconds === 0)?.meta ??
    null;

  const playheadFromSource = useCallback(() => {
    const meta = getMasterMeta();
    const context = audioContextRef.current;
    const duration = durationRef.current;

    if (!meta || !context || duration <= 0) {
      return offsetToTime(
        offsetRef.current,
        loopWidthRef.current,
        duration,
        viewportWidthRef.current,
      );
    }

    const elapsed = (context.currentTime - meta.startedAt) * meta.rate;
    const loopStart = loopStartRef.current;
    const bufferPosition = wrapLoopTime(
      meta.bufferOffset + elapsed,
      loopStart,
      duration,
    );

    if (meta.direction === "forward") {
      return bufferPosition;
    }

    return wrapLoopTime(duration - bufferPosition, loopStart, duration);
  }, []);

  const startPlayback = useCallback(
    async (
      direction: PlaybackDirection,
      rate: number,
      leaderPlayhead: number,
    ) => {
      const forwardBuffer = forwardBufferRef.current;
      const reversedBuffer = reversedBufferRef.current;
      const duration = durationRef.current;
      const loopStart = loopStartRef.current;

      if (!forwardBuffer || !reversedBuffer || duration <= 0) return;

      await ensureAudioContext();

      const context = audioContextRef.current;
      const outputGain = gainNodeRef.current;
      if (!context || !outputGain) return;

      stopPlayback();

      const buffer = direction === "forward" ? forwardBuffer : reversedBuffer;
      const startedAt = context.currentTime;
      const voices: PlaybackVoice[] = [];

      for (const delaySeconds of ALL_TAPE_DELAYS) {
        const tapPlayhead = followerPlayhead(
          leaderPlayhead,
          delaySeconds,
          direction,
          loopStart,
          duration,
        );
        const bufferOffset = playheadToBufferOffset(
          tapPlayhead,
          direction,
          duration,
        );

        const source = context.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        if (direction === "forward" && loopStart > 0 && loopStart < duration) {
          source.loopStart = loopStart;
          source.loopEnd = duration;
        }
        source.playbackRate.value = rate;

        const voiceGain = context.createGain();
        voiceGain.gain.value = voiceGainForDelay(delaySeconds, wetRef.current);
        source.connect(voiceGain);
        voiceGain.connect(outputGain);
        source.start(0, bufferOffset);

        voices.push({
          source,
          gainNode: voiceGain,
          meta: {
            direction,
            rate,
            startedAt,
            bufferOffset,
            delaySeconds,
          },
        });
      }

      voicesRef.current = voices;
    },
    [ensureAudioContext, stopPlayback],
  );

  const syncOffsetFromPlayhead = useCallback((playhead: number) => {
    const loopWidth = loopWidthRef.current;
    const duration = durationRef.current;
    const viewportWidth = viewportWidthRef.current;
    if (loopWidth <= 0 || duration <= 0 || viewportWidth <= 0) return;

    offsetRef.current = timeToOffset(
      playhead,
      loopWidth,
      duration,
      viewportWidth,
    );
    if (trackRef.current) {
      trackRef.current.style.transform = `translateX(${-offsetRef.current}px)`;
    }
  }, []);

  const syncOffsetToLoopStart = useCallback(() => {
    syncOffsetFromPlayhead(loopStartRef.current);
  }, [syncOffsetFromPlayhead]);

  const resetToLoopStart = useCallback(async () => {
    syncOffsetToLoopStart();
    const rate = playbackRateRef.current;
    if (rate === 0 || !headEngagedRef.current) return;

    const direction: PlaybackDirection = rate > 0 ? "forward" : "reverse";
    await startPlayback(direction, Math.abs(rate), loopStartRef.current);
  }, [startPlayback, syncOffsetToLoopStart]);

  useImperativeHandle(
    ref,
    () => ({ resetToLoopStart: () => void resetToLoopStart() }),
    [resetToLoopStart],
  );

  const syncAudioToOffset = useCallback(() => {
    stopPlayback();
    const playhead = offsetToTime(
      offsetRef.current,
      loopWidthRef.current,
      durationRef.current,
      viewportWidthRef.current,
    );
    syncOffsetFromPlayhead(playhead);
  }, [stopPlayback, syncOffsetFromPlayhead]);

  const syncAudioPlayback = useCallback(async () => {
    const loopWidth = loopWidthRef.current;
    const duration = durationRef.current;
    const rate = playbackRateRef.current;

    if (loopWidth <= 0 || duration <= 0) return;

    if (rate === 0 || !headEngagedRef.current) {
      stopPlayback();
      return;
    }

    const direction: PlaybackDirection = rate > 0 ? "forward" : "reverse";
    const playhead = offsetToTime(
      offsetRef.current,
      loopWidth,
      duration,
      viewportWidthRef.current,
    );

    await startPlayback(direction, Math.abs(rate), playhead);
  }, [startPlayback, stopPlayback]);

  const applyPlaybackRate = useCallback(
    async (rate: number) => {
      const duration = durationRef.current;

      playbackRateRef.current = rate;
      setDisplayRate(rate);
      if (rate !== 0) {
        const direction: PlaybackDirection = rate > 0 ? "forward" : "reverse";
        setPlaybackDirection((prev) =>
          prev === direction ? prev : direction,
        );
      }
      speedRef.current = playbackRateToSpeed(
        rate,
        viewportWidthRef.current,
        duration,
      );

      await syncAudioPlayback();
    },
    [syncAudioPlayback],
  );

  const handleSpeedSliderChange = useCallback(
    (value: number) => {
      void ensureAudioContext();
      if (Math.abs(value) < 0.05) {
        void applyPlaybackRate(0);
        return;
      }
      void applyPlaybackRate(quantizePlaybackRate(value));
    },
    [applyPlaybackRate, ensureAudioContext],
  );

  const toggleHeadEngagement = useCallback(() => {
    void ensureAudioContext();
    const next = !headEngagedRef.current;
    headEngagedRef.current = next;
    setHeadEngaged(next);
    void syncAudioPlayback();
  }, [ensureAudioContext, syncAudioPlayback]);

  const drawWaveforms = useCallback(() => {
    const samples = peaksRef.current;
    const viewport = viewportRef.current;
    if (!samples || !viewport) return;

    const viewportWidth = viewport.clientWidth;
    if (viewportWidth <= 0) return;

    viewportWidthRef.current = viewportWidth;
    const loopWidth = loopWidthForDuration(viewportWidth, durationRef.current);
    loopWidthRef.current = loopWidth;
    setSegmentWidth(loopWidth);

    for (const canvas of [canvasARef.current, canvasBRef.current]) {
      if (!canvas) continue;
      canvas.style.width = `${loopWidth}px`;
      drawWaveform(canvas, samples, loopWidth);
    }

    const rate = playbackRateRef.current;
    if (rate !== 0 && durationRef.current > 0) {
      speedRef.current = playbackRateToSpeed(
        rate,
        viewportWidth,
        durationRef.current,
      );
    }

    if (durationRef.current > 0) {
      syncOffsetToLoopStart();
    }
  }, [syncOffsetToLoopStart]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    let cancelled = false;

    const loadAudio = async () => {
      const src = audio.currentSrc || audio.src;
      if (!src) return;

      try {
        const decoded = await decodeAudio(src);
        if (cancelled) return;

        peaksRef.current = decoded.peaks;
        forwardBufferRef.current = decoded.forwardBuffer;
        reversedBufferRef.current = decoded.reversedBuffer;
        durationRef.current = decoded.duration;
        setTrackDuration(decoded.duration);
        setLoopStartTime(loopStartRef.current);

        audio.pause();
        audio.muted = true;
        audio.loop = true;

        setPeaks(decoded.peaks);
      } catch {
        if (!cancelled) {
          peaksRef.current = null;
          forwardBufferRef.current = null;
          reversedBufferRef.current = null;
          durationRef.current = 0;
          setTrackDuration(0);
          setSegmentWidth(0);
          setLoopStartTime(0);
          setPeaks(null);
        }
      }
    };

    const onMetadata = () => {
      void loadAudio();
    };

    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
      onMetadata();
    } else {
      audio.addEventListener("loadedmetadata", onMetadata, { once: true });
    }

    return () => {
      cancelled = true;
      stopPlayback();
    };
  }, [audioRef, stopPlayback]);

  useEffect(() => {
    drawWaveforms();
  }, [peaks, drawWaveforms]);

  useEffect(() => {
    if (defaultsAppliedRef.current || trackDuration <= 0 || segmentWidth <= 0) {
      return;
    }
    defaultsAppliedRef.current = true;
    if (defaultSpeed === 0) return;

    playbackRateRef.current = defaultSpeed;
    setDisplayRate(defaultSpeed);
    setPlaybackDirection(defaultSpeed > 0 ? "forward" : "reverse");
    speedRef.current = playbackRateToSpeed(
      defaultSpeed,
      viewportWidthRef.current,
      durationRef.current,
    );
    void syncAudioPlayback();
  }, [trackDuration, segmentWidth, defaultSpeed, syncAudioPlayback]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const observer = new ResizeObserver(drawWaveforms);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [drawWaveforms]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    let raf = 0;
    let lastTime = performance.now();

    const tick = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;

      const loopWidth = loopWidthRef.current;
      const duration = durationRef.current;

      if (!draggingRef.current && !reducedMotionRef.current) {
        const blend = 1 - Math.exp(-RETURN_RATE * dt);
        speedRef.current +=
          (BASE_SPEED_PX_S - speedRef.current) * blend;

        const speed = speedRef.current;

        if (loopWidth > 0 && duration > 0) {
          const rate = playbackRateRef.current;

          if (rate !== 0) {
            const direction: PlaybackDirection =
              rate > 0 ? "forward" : "reverse";
            const absRate = Math.abs(rate);

            if (headEngagedRef.current) {
              const meta = getMasterMeta();

              if (
                !meta ||
                meta.direction !== direction ||
                Math.abs(meta.rate - absRate) > 0.05
              ) {
                const playhead = offsetToTime(
                  offsetRef.current,
                  loopWidth,
                  duration,
                  viewportWidthRef.current,
                );
                void startPlayback(direction, absRate, playhead);
              } else if (
                voicesRef.current.length > 0 &&
                audioContextRef.current
              ) {
                const leaderPlayhead = playheadFromSource();
                const startedAt = audioContextRef.current.currentTime;

                for (const voice of voicesRef.current) {
                  const tapPlayhead = followerPlayhead(
                    leaderPlayhead,
                    voice.meta.delaySeconds,
                    direction,
                    loopStartRef.current,
                    duration,
                  );
                  const bufferOffset = playheadToBufferOffset(
                    tapPlayhead,
                    direction,
                    duration,
                  );

                  voice.source.playbackRate.value = absRate;
                  voice.meta = {
                    direction,
                    rate: absRate,
                    startedAt,
                    bufferOffset,
                    delaySeconds: voice.meta.delaySeconds,
                  };
                }
              }

              syncOffsetFromPlayhead(playheadFromSource());
            } else {
              stopPlayback();
              offsetRef.current = wrapOffset(
                offsetRef.current + speed * dt,
                loopWidth,
              );
            }
          } else {
            stopPlayback();
            offsetRef.current = wrapOffset(
              offsetRef.current + speed * dt,
              loopWidth,
            );
            syncOffsetFromPlayhead(
              offsetToTime(
                offsetRef.current,
                loopWidth,
                duration,
                viewportWidthRef.current,
              ),
            );
          }
        } else {
          offsetRef.current = wrapOffset(
            offsetRef.current + speed * dt,
            loopWidth,
          );
        }
      }

      track.style.transform = `translateX(${-offsetRef.current}px)`;
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [
    playheadFromSource,
    startPlayback,
    stopPlayback,
    syncOffsetFromPlayhead,
  ]);

  const applyDragDelta = (dx: number) => {
    offsetRef.current = wrapOffset(
      offsetRef.current - dx,
      loopWidthRef.current,
    );
    if (trackRef.current) {
      trackRef.current.style.transform = `translateX(${-offsetRef.current}px)`;
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.classList.add("slider-viewport--dragging");
    lastPointerStartRef.current = { x: e.clientX, t: e.timeStamp };
    lastPointerRef.current = { x: e.clientX, t: e.timeStamp };
    void ensureAudioContext();
    stopPlayback();
    playbackRateRef.current = 0;
    setDisplayRate(0);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;

    const { x } = lastPointerRef.current;
    const dx = e.clientX - x;
    lastPointerRef.current = { x: e.clientX, t: e.timeStamp };
    applyDragDelta(dx);
    syncAudioToOffset();
  };

  const onPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;

    draggingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    e.currentTarget.classList.remove("slider-viewport--dragging");

    const { x, t } = lastPointerStartRef.current;
    const dx = e.clientX - x;
    const dt = e.timeStamp - t;
    const pointerVelocityPxS = dt > 0 ? (dx / dt) * 1000 : 0;
    const speed = -pointerVelocityPxS;

    const duration = durationRef.current;
    const clampedSpeed = Math.min(
      MAX_SPEED_PX_S,
      Math.max(MIN_SPEED_PX_S, speed),
    );

    const quantized = quantizeFromSpeed(
      clampedSpeed,
      viewportWidthRef.current,
      duration,
    );
    playbackRateRef.current = quantized;
    setDisplayRate(quantized);
    if (quantized !== 0) {
      const direction: PlaybackDirection =
        quantized > 0 ? "forward" : "reverse";
      setPlaybackDirection((prev) => (prev === direction ? prev : direction));
    }
    speedRef.current = playbackRateToSpeed(
      quantized,
      viewportWidthRef.current,
      duration,
    );

    void syncAudioPlayback();
  };

  const loopMarkerLeftPx =
    trackDuration > 0 && segmentWidth > 0
      ? (loopStartTime / trackDuration) * segmentWidth
      : 0;

  return (
    <div className="slider-row">
      <div className="slider-controls">
        <MixControl
          label="Speed"
          value={displayRate}
          min={-8}
          max={8}
          step={0.01}
          onChange={handleSpeedSliderChange}
          format={formatPlaybackRate}
        />
        <MixControl
          label="DELAY"
          value={wet}
          min={0}
          max={1}
          step={0.01}
          disabled={!headEngaged}
          onChange={handleWetChange}
          format={(v) => `${Math.round(v * 100)}`}
        />
      </div>
      <div
        className="slider-root"
        style={
          {
            "--delay-wet": headEngaged ? wet : 0,
          } as React.CSSProperties
        }
      >
        <button
          type="button"
          className={`slider-play-head slider-play-head--leader${
            headEngaged ? " slider-play-head--engaged" : ""
          }`}
          aria-label={headEngaged ? "Disengage play head" : "Engage play head"}
          aria-pressed={headEngaged}
          disabled={trackDuration <= 0}
          onClick={toggleHeadEngagement}
        />
        {headEngaged &&
          trackDuration > 0 &&
          TAPE_DELAY_SECONDS.map((delay) => (
            <div
              key={delay}
              className="slider-play-head slider-play-head--delay"
              style={{
                left: tapeDelayHeadLeft(delay, playbackDirection),
              }}
              aria-hidden
            />
          ))}
        <div className="slider">
          <div
            ref={viewportRef}
            className="slider-viewport"
          aria-label="Audio waveform. Drag or flick horizontally to change speed."
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        >
          <div ref={trackRef} className="slider-track">
            {segmentWidth > 0 && trackDuration > 0 && (
              <>
                <div
                  className="slider-loop-marker"
                  style={{ left: loopMarkerLeftPx }}
                  aria-hidden
                />
                <div
                  className="slider-loop-marker"
                  style={{ left: loopMarkerLeftPx + segmentWidth }}
                  aria-hidden
                />
              </>
            )}
            <canvas ref={canvasARef} className="slider-waveform" />
            <canvas
              ref={canvasBRef}
              className="slider-waveform"
              aria-hidden
            />
          </div>
        </div>
      </div>
      </div>
      <div className="slider-mix-controls">
        <MixControl
          label="Vol"
          value={volume}
          min={0}
          max={1}
          step={0.01}
          onChange={handleVolumeChange}
          format={(v) => `${Math.round(v * 100)}`}
        />
        <MixControl
          label="Pan"
          value={pan}
          min={-1}
          max={1}
          step={0.01}
          onChange={handlePanChange}
          format={(v) => {
            if (v < -0.05) return "L";
            if (v > 0.05) return "R";
            return "C";
          }}
        />
      </div>
    </div>
  );
});
