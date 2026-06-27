export type MixControlProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  onChange: (value: number) => void;
  format?: (value: number) => string;
};

export function MixControl({
  label,
  value,
  min,
  max,
  step = 0.01,
  disabled = false,
  onChange,
  format,
}: MixControlProps) {
  const display = format ? format(value) : String(value);

  return (
    <div
      className={`slider-mix-control${
        disabled ? " slider-mix-control--disabled" : ""
      }`}
    >
      <div className="slider-mix-control-header">
        <span className="slider-mix-label">{label}</span>
        <span className="slider-mix-value">{display}</span>
      </div>
      <input
        type="range"
        className="slider-mix-range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
      />
    </div>
  );
}
