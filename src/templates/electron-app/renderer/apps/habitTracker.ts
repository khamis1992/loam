import { element, errorStatus, page, status } from '../dom.js';
import type { DesktopApi, Habit } from '../types.js';

export function initHabitTracker(desktop: DesktopApi): void {
  page('Loam Habit Tracker', 'Local reminders, daily completions and weekly streaks.', `
    <section class="workspace"><div class="list-heading"><h2>Your habits</h2><span id="count" class="muted"></span></div><div id="habits"></div></section>
    <section class="tag-panel"><h2>New habit</h2><form id="habit-form" class="form-grid">
      <label>Habit name<input id="habit-name" maxlength="80" required placeholder="Read for 20 minutes"></label>
      <label>Reminder<input id="habit-reminder" type="time" value="09:00" required></label>
      <button type="submit">Add habit</button>
    </form><p id="status" class="status" role="status"></p></section>`);

  function row(habit: Habit): HTMLElement {
    const row = document.createElement('article');
    row.className = 'habit-row';
    const name = document.createElement('strong');
    name.textContent = habit.name;
    const details = document.createElement('span');
    details.textContent = `${habit.reminder} · ${habit.weeklyCompletions}/7 this week · ${habit.streak} day streak`;
    const complete = document.createElement('button');
    complete.type = 'button';
    complete.className = habit.completedToday ? 'secondary complete-habit' : 'complete-habit';
    complete.textContent = habit.completedToday ? 'Completed' : 'Complete today';
    complete.disabled = habit.completedToday;
    complete.addEventListener('click', async () => {
      try {
        const habits = await desktop.completeHabit(habit.id);
        render(habits);
        status(`Completed. Streak: ${habits.find((item) => item.id === habit.id)?.streak ?? 0} day.`);
      } catch (error) { errorStatus(error); }
    });
    row.append(name, details, complete);
    return row;
  }

  function render(habits: Habit[]): void {
    element<HTMLDivElement>('#habits').replaceChildren(...habits.map(row));
    element<HTMLSpanElement>('#count').textContent = `${habits.length} habit${habits.length === 1 ? '' : 's'}`;
  }

  element<HTMLFormElement>('#habit-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const habits = await desktop.addHabit({
        name: element<HTMLInputElement>('#habit-name').value,
        reminder: element<HTMLInputElement>('#habit-reminder').value,
        days: [1, 2, 3, 4, 5, 6, 0],
      });
      render(habits);
      element<HTMLInputElement>('#habit-name').value = '';
      status('Habit added. Local reminders are enabled.');
    } catch (error) { errorStatus(error); }
  });

  void desktop.listHabits().then(render).catch(errorStatus);
}
