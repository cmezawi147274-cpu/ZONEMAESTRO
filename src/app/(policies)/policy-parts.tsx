export const CONTACT_EMAIL = "contact@zonemaestro.com"
export const LAST_UPDATED = "18 September 2026"

export function PolicyHeader({ title }: { title: string }) {
  return (
    <div className="mb-10">
      <h1 className="text-[1.9rem] leading-tight font-bold text-white sm:text-[2.25rem]">{title}</h1>
      <p className="mt-1.5 text-[14px] text-gray-400">Last updated {LAST_UPDATED}</p>
    </div>
  )
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-9 space-y-3 text-[15px] leading-relaxed text-gray-400 [&_li]:pl-1 [&_strong]:font-semibold [&_strong]:text-gray-200 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5 [&_ul]:marker:text-gray-600">
      <h2 className="text-[1.1rem] font-semibold text-white">{title}</h2>
      {children}
    </section>
  )
}

export function ContactLink() {
  return (
    <a
      href={`mailto:${CONTACT_EMAIL}`}
      className="rounded-sm text-gray-300 underline decoration-gray-600 underline-offset-2 transition-colors hover:text-white hover:decoration-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#34b4f5]/50"
    >
      {CONTACT_EMAIL}
    </a>
  )
}
