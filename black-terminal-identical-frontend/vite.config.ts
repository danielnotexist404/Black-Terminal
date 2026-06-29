import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
    proxy: {
      "/market-proxy/binance-spot": {
        target: "https://api.binance.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/market-proxy\/binance-spot/, "")
      },
      "/market-proxy/binance-usdm": {
        target: "https://fapi.binance.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/market-proxy\/binance-usdm/, "")
      },
      "/market-proxy/bybit": {
        target: "https://api.bybit.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/market-proxy\/bybit/, "")
      },
      "/market-proxy/okx": {
        target: "https://www.okx.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/market-proxy\/okx/, "")
      }
    }
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2022",
    minify: "esbuild",
    sourcemap: false
  }
});
