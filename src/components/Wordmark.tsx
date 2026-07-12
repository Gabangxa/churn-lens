/** Logo dot + wordmark, sized for headers. */
export default function Wordmark({ size = 'md' }: { size?: 'sm' | 'md' }) {
  return (
    <span className="inline-flex items-center space-x-3">
      <span
        className={`${size === 'md' ? 'w-5 h-5' : 'w-3.5 h-3.5'} bg-zinc-900 dark:bg-zinc-100 rounded-full transition-colors duration-500`}
      />
      <span
        className={`${size === 'md' ? 'text-2xl' : 'text-lg'} font-extrabold font-display tracking-tight text-zinc-900 dark:text-zinc-100 transition-colors duration-500`}
      >
        ChurnLens
      </span>
    </span>
  );
}
