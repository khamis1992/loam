export default function AuthSignupBlock() {
  return (
    <section className="flex min-h-screen items-center justify-center bg-background px-6">
      <form
        className="w-full max-w-sm rounded-lg border border-border bg-card p-6"
        onSubmit={(event) => event.preventDefault()}
      >
        <h1 className="text-xl font-semibold text-card-foreground">Create your account</h1>
        <p className="mt-1 text-sm text-muted-foreground">Start your first workspace</p>

        <label htmlFor="name" className="mt-6 block text-sm font-medium text-card-foreground">
          Name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          autoComplete="name"
          required
          className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
        />

        <label htmlFor="signup-email" className="mt-4 block text-sm font-medium text-card-foreground">
          Email
        </label>
        <input
          id="signup-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
        />

        <label htmlFor="signup-password" className="mt-4 block text-sm font-medium text-card-foreground">
          Password
        </label>
        <input
          id="signup-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
        />

        <label className="mt-4 flex items-start gap-2 text-sm text-muted-foreground">
          <input type="checkbox" required className="mt-0.5" />
          <span>I agree to the terms of service and privacy policy.</span>
        </label>

        <button
          type="submit"
          className="mt-6 h-10 w-full rounded-md bg-primary text-sm font-medium text-primary-foreground"
        >
          Create account
        </button>
      </form>
    </section>
  );
}
