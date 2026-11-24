import { listProfileOptions } from "@/config/profiles";
import type { ProfileId } from "@/lib/engine/types";

interface Props {
  profileId: ProfileId;
  onProfileChange: (id: ProfileId) => void;
}

const OPTIONS = listProfileOptions();

/** Four preset profiles as a native radio group: arrow keys move between them, Tab enters and leaves. */
export function ProfileSelector({ profileId, onProfileChange }: Props) {
  return (
    <fieldset className="space-y-3">
      <legend className="text-xl font-semibold">Who is this for?</legend>
      <p className="text-ink-muted">Preset profiles. Recommendations use the profile&apos;s typical routine; no personal details are collected.</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {OPTIONS.map((option) => {
          const checked = option.id === profileId;
          const id = `profile-${option.id}`;
          return (
            <div key={option.id} className="relative">
              <input
                type="radio"
                id={id}
                name="profile"
                value={option.id}
                checked={checked}
                onChange={() => onProfileChange(option.id)}
                className="peer sr-only"
              />
              <label
                htmlFor={id}
                className="block h-full cursor-pointer rounded-2xl border border-line-strong bg-surface p-4 peer-checked:border-brand peer-checked:bg-info-bg peer-checked:ring-2 peer-checked:ring-brand peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand"
              >
                <span className="flex items-start justify-between gap-2">
                  <span className="font-semibold">{option.label}</span>
                  <span aria-hidden="true" className={checked ? "mt-1 size-4 shrink-0 rounded-full border-4 border-brand bg-surface" : "mt-1 size-4 shrink-0 rounded-full border-2 border-line-strong"} />
                </span>
                <span className="mt-1 block text-sm text-ink-muted">{option.description}</span>
              </label>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
