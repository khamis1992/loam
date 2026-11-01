import { useState } from "react";
import { Input } from "./components/Input.js";

export function SignupForm() {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setErrors({
      name: name.trim().length > 0 ? null : "Name is required.",
      password: password.length >= 8 ? null : "Password needs at least 8 characters.",
    });
  }

  return (
    <form className="signup-form" onSubmit={submit}>
      <h1>Sign up</h1>
      <Input label="Name" value={name} onChange={setName} error={errors.name} />
      <Input label="Password" value={password} onChange={setPassword} type="password" error={errors.password} />
      <button type="submit">Create account</button>
    </form>
  );
}
