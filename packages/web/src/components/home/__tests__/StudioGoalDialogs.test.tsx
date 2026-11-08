import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StudioGoalDialog, StudioPickerDialog } from '../StudioGoalDialogs';
import { BUILD_GOALS, CREATE_GOALS } from '../studioGoals';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

afterEach(() => {
  cleanup();
  push.mockClear();
  vi.restoreAllMocks();
});

describe('StudioPickerDialog', () => {
  it('shows the desktop Build options and selects a goal', () => {
    const onSelect = vi.fn();
    render(<StudioPickerDialog kind="build" onClose={vi.fn()} onSelect={onSelect} />);

    expect(screen.getByRole('dialog', { name: 'Build' })).toBeTruthy();
    expect(screen.getByText('Websites')).toBeTruthy();
    fireEvent.click(screen.getByTestId('studio-goal-desktop-app'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'desktop-app' }));
  });

  it('enables the mobile and game service packs without converting them to websites', () => {
    const onSelect = vi.fn();
    render(<StudioPickerDialog kind="build" onClose={vi.fn()} onSelect={onSelect} />);
    expect(BUILD_GOALS.find((goal) => goal.id === 'websites')?.directRoute).toBeUndefined();
    expect(screen.getByTestId('studio-goal-mobile-app')).not.toBeDisabled();
    expect(screen.getByTestId('studio-goal-game-development')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('studio-goal-mobile-app'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'mobile-app' }));
    fireEvent.click(screen.getByTestId('studio-goal-game-development'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'game-development' }));
  });

  it('groups all Create options into Document and Media', () => {
    const onSelect = vi.fn();
    render(<StudioPickerDialog kind="create" onClose={vi.fn()} onSelect={onSelect} />);

    expect(screen.getByRole('heading', { name: 'Document' })).toBeTruthy();
    expect(screen.getByText('Media')).toBeTruthy();
    for (const id of ['slides', 'document', 'spreadsheet', 'visualization', 'image', 'video', 'audio']) {
      expect(screen.getByTestId(`studio-goal-${id}`)).toBeTruthy();
    }
    fireEvent.click(screen.getByTestId('studio-goal-visualization'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'visualization' }));
  });
});

describe('StudioGoalDialog', () => {
  it('shows local desktop execution and the five usable desktop briefs', () => {
    const goal = BUILD_GOALS.find((item) => item.id === 'desktop-app')!;
    render(<StudioGoalDialog goal={goal} onClose={vi.fn()} onLaunch={vi.fn()} />);
    expect(screen.getByTestId('desktop-goal-this-pc')).toHaveTextContent('This PC');
    expect(goal.suggestions).toHaveLength(5);
    for (const suggestion of goal.suggestions) expect(screen.getByText(suggestion)).toBeInTheDocument();
  });

  it('launches a suggested brief with the selected visualization options', async () => {
    const onLaunch = vi.fn().mockResolvedValue(undefined);
    const goal = CREATE_GOALS.find((item) => item.id === 'visualization')!;
    render(<StudioGoalDialog goal={goal} onClose={vi.fn()} onLaunch={onLaunch} />);

    fireEvent.click(screen.getByRole('radio', { name: 'Slides' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bar' }));
    fireEvent.click(screen.getByText('Explore churn drivers with charts and findings'));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(onLaunch).toHaveBeenCalledWith(
      goal,
      'Explore churn drivers with charts and findings',
      { format: 'Slides', chart: 'Bar' },
    ));
  });

  it('opens the real design studio from the image goal', () => {
    const goal = CREATE_GOALS.find((item) => item.id === 'image')!;
    render(<StudioGoalDialog goal={goal} onClose={vi.fn()} onLaunch={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open Canvas' }));
    expect(push).toHaveBeenCalledWith('/app/design');
  });

  it('renders the video gallery and filters templates by category', () => {
    const goal = CREATE_GOALS.find((item) => item.id === 'video')!;
    render(<StudioGoalDialog goal={goal} onClose={vi.fn()} onLaunch={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'The Parrot' })).toBeTruthy();
    expect(screen.getByText('Made with Loam')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Marketing' }));
    expect(screen.getByRole('button', { name: 'Promotional ad' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Product showcase' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Short film' })).toBeNull();
  });

  it('renders the game gallery with all four game cards', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const goal = BUILD_GOALS.find((item) => item.id === 'game-development')!;
    render(<StudioGoalDialog goal={goal} onClose={vi.fn()} onLaunch={vi.fn()} />);

    expect(screen.getByText('Explore games')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Brick Bash game area' })).toBeTruthy();
    for (const name of goal.suggestions) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
  });
});
