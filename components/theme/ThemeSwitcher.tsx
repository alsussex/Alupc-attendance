"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "@/components/theme/ThemeProvider";
import type { ThemePreference } from "@/lib/domain";

const options = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] satisfies Array<{
  value: ThemePreference;
  label: string;
  icon: typeof Sun;
}>;

export function ThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const { preference, setPreference } = useTheme();
  const [open, setOpen] = useState(false);
  const compactRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === preference)!;

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!compactRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeWithEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeWithEscape);
    };
  }, [open]);

  if (compact) {
    const SelectedIcon = selected.icon;
    return (
      <div ref={compactRef} className="theme-switcher-compact">
        <button
          type="button"
          aria-label={`Appearance: ${selected.label}`}
          aria-haspopup="menu"
          aria-expanded={open}
          title={`Appearance: ${selected.label}`}
          onClick={() => setOpen((current) => !current)}
        >
          <SelectedIcon aria-hidden="true" />
        </button>
        {open && (
          <div className="theme-switcher-popover" role="menu" aria-label="Appearance">
            {options.map((option) => {
              const Icon = option.icon;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={preference === option.value}
                  onClick={() => {
                    setPreference(option.value);
                    setOpen(false);
                  }}
                >
                  <Icon aria-hidden="true" />
                  {option.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }
  return (
    <fieldset className="theme-switcher">
      <legend>Appearance</legend>
      <div role="radiogroup" aria-label="Appearance">
        {options.map((option) => {
          const Icon = option.icon;
          return (
            <label
              key={option.value}
              title={compact ? option.label : undefined}
            >
              <input
                type="radio"
                name="application-theme"
                value={option.value}
                checked={preference === option.value}
                onChange={() => setPreference(option.value)}
              />
              <Icon aria-hidden="true" />
              <span>{option.label}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
