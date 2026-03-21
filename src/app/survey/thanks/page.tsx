export default function SurveyThanksPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-950 px-6 py-16 text-center">
      <div className="w-full max-w-sm">
        <span className="text-sm text-zinc-500">
          Powered by Churn<span className="text-brand-400">Lens</span>
        </span>

        <div className="mt-8 flex justify-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-500/10">
            <svg
              className="h-7 w-7 text-brand-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
        </div>

        <h1 className="mt-6 text-xl font-bold text-zinc-100">Thanks for your feedback</h1>
        <p className="mt-3 text-sm text-zinc-400 leading-relaxed">
          Your response goes directly to the founder. It genuinely helps shape what gets built next.
        </p>
      </div>
    </div>
  );
}
