"use client";

import { motion } from "framer-motion";

import { Button } from "@/components/ui/button";

function FloatingPaths({ position }: { position: number }) {
  const paths = Array.from({ length: 42 }, (_, i) => ({
    id: i,
    d: `M-${380 - i * 5 * position} -${189 + i * 6}C-${
      380 - i * 5 * position
    } -${189 + i * 6} -${312 - i * 5 * position} ${216 - i * 6} ${152 - i * 5 * position} ${
      343 - i * 6
    }C${616 - i * 5 * position} ${470 - i * 6} ${684 - i * 5 * position} ${875 - i * 6} ${
      684 - i * 5 * position
    } ${875 - i * 6}`,
    width: 0.45 + i * 0.028,
    /** 错开周期，避免整屏同时变暗（略慢，观感更从容） */
    cycle: 9 + (i % 14) * 1.2,
  }));

  return (
    <div className="absolute inset-0 pointer-events-none">
      <svg className="h-full w-full text-[color:var(--hero-path-color)]" viewBox="0 0 696 316" fill="none">
        <title>Background Paths</title>
        {paths.map((path) => (
          <motion.path
            key={path.id}
            d={path.d}
            stroke="currentColor"
            strokeWidth={path.width}
            strokeOpacity={0.2 + Math.min(path.id, 28) * 0.022}
            initial={{ pathLength: 0.45, opacity: 0.62 }}
            animate={{
              pathLength: 1,
              opacity: [0.5, 0.94, 0.5],
              pathOffset: [0, 1, 0],
            }}
            transition={{
              duration: path.cycle,
              repeat: Number.POSITIVE_INFINITY,
              ease: "linear",
              repeatDelay: 0,
            }}
          />
        ))}
      </svg>
    </div>
  );
}

export function BackgroundPathLayer() {
  return (
    <div className="absolute inset-0 opacity-100">
      {/* 底层微光，避免线条在动画低谷时整屏发空 */}
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_120%_70%_at_50%_18%,rgba(124,111,154,0.09),transparent_55%)]"
        aria-hidden
      />
      <FloatingPaths position={1} />
      <FloatingPaths position={-1} />
    </div>
  );
}

export function BackgroundPaths({ title = "Background Paths" }: { title?: string }) {
  const words = title.split(" ");

  return (
    <div className="relative flex min-h-screen w-full items-center justify-center overflow-hidden bg-neutral-950">
      <div className="absolute inset-0">
        <FloatingPaths position={1} />
        <FloatingPaths position={-1} />
      </div>

      <div className="relative z-10 container mx-auto px-4 text-center md:px-6">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 2 }}
          className="mx-auto max-w-4xl"
        >
          <h1 className="mb-8 text-5xl font-bold tracking-tighter text-theme-1 sm:text-7xl md:text-8xl">
            {words.map((word, wordIndex) => (
              <span key={wordIndex} className="mr-4 inline-block last:mr-0">
                {word.split("").map((letter, letterIndex) => (
                  <motion.span
                    key={`${wordIndex}-${letterIndex}`}
                    initial={{ y: 100, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{
                      delay: wordIndex * 0.1 + letterIndex * 0.03,
                      type: "spring",
                      stiffness: 150,
                      damping: 25,
                    }}
                    className="inline-block bg-gradient-to-r from-zinc-100 to-zinc-300/80 bg-clip-text text-transparent"
                  >
                    {letter}
                  </motion.span>
                ))}
              </span>
            ))}
          </h1>

          <div className="group relative inline-block overflow-hidden rounded-2xl bg-gradient-to-b from-white/10 to-black/10 p-px shadow-lg transition-shadow duration-300 hover:shadow-xl">
            <Button
              variant="ghost"
              className="rounded-[1.15rem] border border-white/10 bg-black/90 px-8 py-6 text-lg font-semibold text-white transition-all duration-300 hover:bg-black/100 hover:shadow-md hover:shadow-neutral-800/50 group-hover:-translate-y-0.5"
            >
              <span className="opacity-90 transition-opacity group-hover:opacity-100">Discover Excellence</span>
              <span className="ml-3 opacity-70 transition-all duration-300 group-hover:translate-x-1.5 group-hover:opacity-100">
                →
              </span>
            </Button>
          </div>
        </motion.div>
      </div>
    </div>
  );
}

