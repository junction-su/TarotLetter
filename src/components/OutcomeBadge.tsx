"use client";

import { OutcomeStatus } from "@/types/entry";

const config: Record<
  OutcomeStatus,
  { label: string; className: string }
> = {
  none: {
    label: "Awaiting",
    className: "bg-twilight text-lavender",
  },
  accurate: {
    label: "Accurate",
    className: "bg-sage/20 text-sage",
  },
  mixed: {
    label: "Mixed",
    className: "bg-gold/20 text-gold",
  },
  inaccurate: {
    label: "Inaccurate",
    className: "bg-coral/20 text-coral",
  },
};

export default function OutcomeBadge({ status }: { status: OutcomeStatus }) {
  const { label, className } = config[status];
  return (
    <span className={`inline-block rounded-full px-3 py-1 text-xs font-medium ${className}`}>
      {label}
    </span>
  );
}
