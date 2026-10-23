export default function SettingsProfileBlock() {
  return (
    <section className="bg-background">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <h2 className="text-xl font-semibold text-foreground">Profile</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          This information is shown to other members of your workspace.
        </p>

        <form className="mt-8 flex flex-col gap-6" onSubmit={(event) => event.preventDefault()}>
          <div className="flex items-center gap-4">
            <div className="h-16 w-16 rounded-full bg-muted" aria-hidden="true" />
            <button
              type="button"
              className="h-9 rounded-md border border-border px-3 text-sm font-medium text-foreground"
            >
              Change avatar
            </button>
          </div>

          <div>
            <label htmlFor="display-name" className="block text-sm font-medium text-foreground">
              Display name
            </label>
            <input
              id="display-name"
              name="displayName"
              type="text"
              defaultValue="Maya Haddad"
              className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div>
            <label htmlFor="bio" className="block text-sm font-medium text-foreground">
              Bio
            </label>
            <textarea
              id="bio"
              name="bio"
              rows={3}
              defaultValue="Product engineer. I like small tools that do one thing well."
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="flex justify-end gap-3 border-t border-border pt-4">
            <button
              type="button"
              className="h-10 rounded-md border border-border px-4 text-sm font-medium text-foreground"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
            >
              Save changes
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
