'use client';

import { t } from '@/i18n/t';
import { Row, Section } from './SettingsDialog';
import { KEYBINDING_GROUPS, bindingsByGroup, displayKeys } from '@/lib/keybindings';

export function ShortcutsPane() {
  return (
    <div className="space-y-2">
      {KEYBINDING_GROUPS.map((group) => (
        <Section key={group.id} title={t(group.title)}>
          {bindingsByGroup(group.id).map((binding) => (
            <Row key={binding.id} label={t(binding.description)}>
              <span className="flex flex-wrap items-center justify-end gap-1">
                <Kbd>{displayKeys(binding)}</Kbd>
              </span>
            </Row>
          ))}
        </Section>
      ))}
    </div>
  );
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-block rounded-[6px] border border-border-main bg-fill-tsp px-2 py-0.5 text-xs text-text-secondary">
      {children}
    </kbd>
  );
}
