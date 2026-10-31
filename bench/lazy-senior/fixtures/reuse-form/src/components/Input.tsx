import { validateEmail } from "../utils/validate.js";

export interface InputProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "email" | "password";
  error?: string;
}

/** The project's one input component. New forms reuse this; do not add another. */
export function Input({ label, value, onChange, type = "text", error }: InputProps) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        className={error ? "field-input field-input-error" : "field-input"}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {error ? <span className="field-error">{error}</span> : null}
    </label>
  );
}

export { validateEmail };
