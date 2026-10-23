import { useState } from "react";

export default function RtlAuthLoginBlock() {
  const [showPassword, setShowPassword] = useState(false);

  return (
    <section dir="rtl" className="flex min-h-screen items-center justify-center bg-background px-6">
      <form
        className="w-full max-w-sm rounded-lg border border-border bg-card p-6"
        onSubmit={(event) => event.preventDefault()}
      >
        <h1 className="text-xl font-semibold text-card-foreground">مرحبًا بعودتك</h1>
        <p className="mt-1 text-sm text-muted-foreground">سجّل الدخول إلى حسابك</p>

        <label htmlFor="rtl-email" className="mt-6 block text-sm font-medium text-card-foreground">
          البريد الإلكتروني
        </label>
        <input
          id="rtl-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
        />

        <div className="mt-4 flex items-center justify-between">
          <label htmlFor="rtl-password" className="text-sm font-medium text-card-foreground">
            كلمة المرور
          </label>
          <a href="#reset" className="text-xs text-primary">
            هل نسيتها؟
          </a>
        </div>
        <input
          id="rtl-password"
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
          إظهار كلمة المرور
        </label>

        <button
          type="submit"
          className="mt-6 h-10 w-full rounded-md bg-primary text-sm font-medium text-primary-foreground"
        >
          تسجيل الدخول
        </button>
      </form>
    </section>
  );
}
