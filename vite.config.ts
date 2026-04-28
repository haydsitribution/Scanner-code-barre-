import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import dts from "vite-plugin-dts";
import { resolve } from "node:path";

const SRC = resolve(__dirname, "src");

export default defineConfig(({ command, mode }) => {
  const isLib = command === "build" && mode !== "demo";

  if (isLib) {
    return {
      plugins: [
        react(),
        dts({ include: ["src"], insertTypesEntry: true, rollupTypes: false }),
      ],
      resolve: { alias: { "@": SRC } },
      build: {
        lib: {
          entry: resolve(SRC, "index.ts"),
          formats: ["es"],
          fileName: () => "index.js",
        },
        rollupOptions: {
          external: ["react", "react-dom", "react/jsx-runtime"],
          output: {
            globals: { react: "React", "react-dom": "ReactDOM" },
            assetFileNames: (info) => {
              if (info.name && info.name.endsWith(".css")) return "style.css";
              return "[name][extname]";
            },
          },
        },
        sourcemap: true,
        emptyOutDir: true,
        target: "es2022",
      },
      worker: { format: "es" },
    };
  }

  return {
    plugins: [react()],
    resolve: { alias: { "@": SRC } },
    server: { host: "0.0.0.0", port: 5173 },
    worker: { format: "es" },
  };
});
