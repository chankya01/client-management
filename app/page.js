"use client";

import { useEffect } from "react";

export default function HomePage() {
  useEffect(() => {
    let cancelled = false;

    async function bootLegacyApp() {
      if (cancelled) return;
      await import("../src/main.js");
    }

    bootLegacyApp();

    return () => {
      cancelled = true;
    };
  }, []);

  return <div id="root" />;
}
