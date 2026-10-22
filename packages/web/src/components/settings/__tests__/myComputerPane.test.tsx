import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MyComputerPane } from '../MyComputerPane';
import { setLocale } from '@/i18n/t';

describe('MyComputerPane', () => {
  afterEach(() => setLocale('en'));

  it('lists the seeded quick-access folders', () => {
    setLocale('en');
    render(<MyComputerPane />);
    expect(screen.getByText('~/Documents/reports')).toBeInTheDocument();
    expect(screen.getByText('~/code/site')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Remove folder' })).toHaveLength(2);
  });

  it('adds a new folder when Add folder is clicked', () => {
    setLocale('en');
    render(<MyComputerPane />);
    const before = screen.getAllByRole('button', { name: 'Remove folder' }).length;

    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }));

    const after = screen.getAllByRole('button', { name: 'Remove folder' });
    expect(after.length).toBe(before + 1);
    expect(screen.getByText('~/newfolder-3')).toBeInTheDocument();
  });

  it('removes a folder and shows the empty state once none remain', () => {
    setLocale('en');
    render(<MyComputerPane />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove folder' })[0]);
    expect(screen.queryByText('~/Documents/reports')).toBeNull();
    expect(screen.getByText('~/code/site')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove folder' }));
    expect(screen.queryByText('~/code/site')).toBeNull();
    expect(screen.getByText('No content')).toBeInTheDocument();
  });
});
