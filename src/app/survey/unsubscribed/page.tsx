export default function SurveyUnsubscribedPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
      <div className="w-full max-w-sm">
        <span className="text-sm font-medium text-muted">
          Powered by <span className="font-extrabold font-display text-zinc-900 dark:text-zinc-100">ChurnLens</span>
        </span>

        <div className="mt-10 flex justify-center">
          <div className="flex h-24 w-24 items-center justify-center rounded-full bg-yellow-300 dark:bg-yellow-300/20 text-yellow-900 dark:text-yellow-300 shadow-xl shadow-yellow-300/40 dark:shadow-none transform -rotate-6 transition-colors duration-500">
            <svg
              className="h-12 w-12"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
        </div>

        <h1 className="mt-8 text-4xl font-extrabold font-display tracking-tight text-zinc-900 dark:text-white transition-colors duration-500">
          You&apos;ve been unsubscribed
        </h1>
        <p className="mt-4 text-base font-medium text-muted leading-relaxed">
          You won&apos;t receive any more exit surveys from this product. No further action needed.
        </p>
      </div>
    </div>
  );
}
