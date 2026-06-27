"use client";

import { useRef } from "react";
import { Slider, type SliderHandle } from "./slider";

export function Main() {
  const audioRef1 = useRef<HTMLAudioElement>(null);
  const audioRef2 = useRef<HTMLAudioElement>(null);
  const audioRef3 = useRef<HTMLAudioElement>(null);
  const audioRef4 = useRef<HTMLAudioElement>(null);
  const sliderRef1 = useRef<SliderHandle>(null);
  const sliderRef2 = useRef<SliderHandle>(null);
  const sliderRef3 = useRef<SliderHandle>(null);
  const sliderRef4 = useRef<SliderHandle>(null);

  const resetAllLoops = () => {
    sliderRef1.current?.resetToLoopStart();
    sliderRef2.current?.resetToLoopStart();
    sliderRef3.current?.resetToLoopStart();
    sliderRef4.current?.resetToLoopStart();
  };

  return (
    <main className="welcome-main">
      <div className="welcome-content">
        <header className="welcome-header">
          <div className="welcome-logo">Music for Seaports</div>
        </header>
        <div className="welcome-section">
          <audio ref={audioRef1} src="/seaport/BASS 4.mp3" preload="metadata" loop />
          <audio ref={audioRef2} src="/seaport/MELO 5.mp3" preload="metadata" loop />
          <audio ref={audioRef3} src="/seaport/TENOR 5.mp3" preload="metadata" loop />
          <audio ref={audioRef4} src="/seaport/TWIN 6.mp3" preload="metadata" loop />
          <Slider ref={sliderRef1} audioRef={audioRef1} />
          <Slider ref={sliderRef2} audioRef={audioRef2} />
          <Slider ref={sliderRef3} audioRef={audioRef3} />
          <Slider ref={sliderRef4} audioRef={audioRef4} />
        </div>
        <div className="transport-strip">
          <button
            type="button"
            className="control-button"
            onClick={resetAllLoops}
          >
            Resync
          </button>
        </div>
        <footer className="main-footer">
          future footer goes here
        </footer>
      </div>
    </main>
  );
}
