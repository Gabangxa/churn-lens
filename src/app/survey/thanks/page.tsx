export default function SurveyThanksPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
      <div className="w-full max-w-sm">
        <span className="text-sm font-medium text-muted">
          Powered by <span className="font-extrabold font-display text-zinc-900 dark:text-zinc-100">ChurnLens</span>
        </span>

        <div className="mt-10 flex justify-center">
          <div className="flex h-24 w-24 items-center justify-center rounded-full bg-teal-400 dark:bg-teal-400/20 text-white dark:text-teal-300 shadow-xl shadow-teal-400/40 dark:shadow-none transition-colors duration-500">
            <svg
              className="h-12 w-12"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
        </div>

        <h1 className="mt-8 text-4xl font-extrabold font-display tracking-tight text-zinc-900 dark:text-white transition-colors duration-500">
          Thanks for your feedback
        </h1>
        <p className="mt-4 text-base font-medium text-muted leading-relaxed">
          Your response goes directly to the founder. It genuinely helps shape what gets built next.
        </p>
      </div>
    </div>
  );
}
