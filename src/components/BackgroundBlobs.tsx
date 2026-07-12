/**
 * Playful background shapes that sit behind the main canvas.
 * Bold in light mode, dimmed to a glow in dark mode.
 */
export default function BackgroundBlobs() {
  return (
    <div aria-hidden="true">
      <div className="absolute top-[-10%] left-[-5%] w-[400px] h-[400px] bg-yellow-300 rounded-full opacity-80 dark:opacity-[0.15] animate-blob transition-opacity duration-500" />
      <div
        className="absolute top-[-15%] right-[-10%] w-[600px] h-[600px] bg-teal-400 rounded-full opacity-80 dark:opacity-[0.15] animate-blob transition-opacity duration-500"
        style={{ animationDelay: '2s' }}
      />
      <div
        className="absolute bottom-[-20%] left-[-10%] w-[700px] h-[700px] bg-pink-500 rounded-full opacity-80 dark:opacity-[0.15] animate-blob transition-opacity duration-500"
        style={{ animationDelay: '4s' }}
      />
      <div
        className="absolute bottom-[-15%] right-[-5%] w-[500px] h-[500px] bg-blue-300 rounded-full opacity-80 dark:opacity-[0.15] animate-blob transition-opacity duration-500"
        style={{ animationDelay: '1s' }}
      />

      {/* Floating accent circles */}
      <div className="absolute top-[25%] left-[20%] w-12 h-12 bg-blue-300 rounded-full opacity-90 dark:opacity-40 transition-opacity duration-500" />
      <div className="absolute bottom-[30%] right-[25%] w-8 h-8 bg-yellow-300 rounded-full opacity-90 dark:opacity-40 transition-opacity duration-500" />
      <div className="absolute top-[40%] right-[15%] w-16 h-16 bg-emerald-400 rounded-full opacity-90 dark:opacity-40 transition-opacity duration-500" />
      <div className="absolute bottom-[20%] left-[30%] w-10 h-10 bg-pink-500 rounded-full opacity-90 dark:opacity-40 transition-opacity duration-500" />
    </div>
  );
}
