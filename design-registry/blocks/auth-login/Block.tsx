import { useState } from "react";

export default function AuthLoginBlock() {
  const [showPassword, setShowPassword] = useState(false);

  return (
    <section className="flex min-h-screen items-center justify-center bg-background px-6">
      <form
        className="w-full max-w-sm rounded-lg border border-border bg-card p-6"
        onSubmit={(event) => event.preventDefault()}
      >
        <h1 className="text-xl font-semibold text-card-foreground">Welcome back</h1>
        <p className="mt-1 text-sm text-muted-foreground">Sign in to your account</p>

        <label htmlFor="email" className="mt-6 block text-sm font-medium text-card-foreground">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
        />

        <div className="mt-4 flex items-center justify-between">
          <label htmlFor="password" className="text-sm font-medium text-card-foreground">
            Password
          </label>
          <a href="#reset" className="text-xs text-primary">
            Forgot?
          </a>
        </div>
        <input
          id="password"
          name="password"
          type={showPassword ? "text" : "password"}
          autoComplete="current-password"
          required
          className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
        />

        <label className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={showPassword}
            onChange={(event) => setShowPassword(event.target.checked)}
          />
          Show password
        </label>

        <button
          type="submit"
          className="mt-6 h-10 w-full rounded-md bg-primary text-sm font-medium text-primary-foreground"
        >
          Sign in
        </button>
      </form>
    </section>
  );
}
