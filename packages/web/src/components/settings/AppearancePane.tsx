import { useState } from 'react';
import { useAppSelector, useAppDispatch, setTheme, setDensity } from '@/store';
import { t } from '@/i18n/t';
import { Row, Section } from './SettingsDialog';

export function AppearancePane() {
  const theme = useAppSelector((s) => s.ui.theme);
  const density = useAppSelector((s) => s.ui.density);
  const dispatch = useAppDispatch();

  return (
    <div className="space-y-2">
      <Section title={t('Theme')}>
        <Row label={t('Theme')} description={t('Choose a light, dark, or system theme on this computer.')}>
          <SegmentedControl
            options={[t('Light'), t('Dark'), t('Auto')]}
            value={theme === 'light' ? t('Light') : theme === 'dark' ? t('Dark') : t('Auto')}
            onChange={(v) => dispatch(setTheme(v === t('Light') ? 'light' : v === t('Dark') ? 'dark' : 'system'))}
          />
        </Row>
      </Section>

      <Section title={t('Interface')}>
        <Row label={t('Accent color')} description={t('Choose the accent color used in the interface.')}>
          <select className="h-row-sm rounded-control border border-border-main bg-fill-tsp px-3 text-sm text-text-primary">
            <option>{t('Default')}</option>
          </select>
        </Row>
        <Row label={t('UI font size')} description={t('Adjust the size of text in the interface.')}>
          <select className="h-row-sm rounded-control border border-border-main bg-fill-tsp px-3 text-sm text-text-primary">
            <option>14px</option>
            <option>15px</option>
            <option selected>16px</option>
          </select>
        </Row>
        <Row label={t('Interface density')} description={t('Adjust the spacing and size of interface elements.')}>
          <SegmentedControl
            options={[t('Compact'), t('Standard')]}
            value={density === 'compact' ? t('Compact') : t('Standard')}
            onChange={(v) => dispatch(setDensity(v === t('Compact') ? 'compact' : 'standard'))}
          />
        </Row>
      </Section>

      <Section title={t('Desktop')}>
        <Row label={t('Activity indicator')} description={t('Show the floating activity indicator when tasks are running.')}>
          <Switch defaultOn={true} />
        </Row>
      </Section>
    </div>
  );
}

function SegmentedControl({ options, value, onChange }: { options: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="inline-flex rounded-control border border-border-main bg-fill-tsp p-0.5">
      {options.map((opt) => (
        <button
          key={opt}
          onClick={() => onChange(opt)}
          className={`h-row-sm px-3 text-sm rounded-[6px] ${opt === value ? 'bg-fill-white text-text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'}`}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

function Switch({ defaultOn = false }: { defaultOn?: boolean }) {
  const [on, setOn] = useState(defaultOn);
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={() => setOn(!on)}
      className="relative h-5 w-9 rounded-full transition-colors"
      style={{ backgroundColor: on ? 'var(--icon-blue)' : 'var(--fill-tsp-white-dark)' }}
    >
      <span
        className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform"
        style={{ transform: on ? 'translateX(18px)' : 'translateX(2px)' }}
      />
    </button>
  );
}
