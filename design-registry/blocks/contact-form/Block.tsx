export default function ContactFormBlock() {
  return (
    <section className="bg-background">
      <div className="mx-auto grid max-w-5xl gap-10 px-6 py-20 lg:grid-cols-2">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">Get in touch</h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Tell us a little about what you are building and we will get back to
            you within one business day.
          </p>
        </div>

        <form className="flex flex-col gap-4" onSubmit={(event) => event.preventDefault()}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="contact-name" className="block text-sm font-medium text-foreground">
                Name
              </label>
              <input
                id="contact-name"
                name="name"
                type="text"
                autoComplete="name"
                required
                className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label htmlFor="contact-email" className="block text-sm font-medium text-foreground">
                Email
              </label>
              <input
                id="contact-email"
                name="email"
                type="email"
                autoComplete="email"
                required
                className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>

          <div>
            <label htmlFor="contact-subject" className="block text-sm font-medium text-foreground">
              Subject
            </label>
            <select
              id="contact-subject"
              name="subject"
              className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
            >
              <option>General</option>
              <option>Sales</option>
              <option>Support</option>
            </select>
          </div>

          <div>
            <label htmlFor="contact-message" className="block text-sm font-medium text-foreground">
              Message
            </label>
            <textarea
              id="contact-message"
              name="message"
              rows={4}
              required
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <button
            type="submit"
            className="h-10 self-start rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground"
          >
            Send message
          </button>
        </form>
      </div>
    </section>
  );
}
