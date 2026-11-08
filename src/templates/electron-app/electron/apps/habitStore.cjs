const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readJson, writeJsonAtomic, text } = require('./helpers.cjs');

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function streak(completions, today) {
  const completed = new Set(completions);
  let count = 0;
  const cursor = new Date(today);
  while (completed.has(dateKey(cursor))) {
    count += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return count;
}

function decodePercent(value) {
  return value.replace(/%([0-9A-Fa-f]{2})/g, (_whole, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

const REMOTE_HABIT = /(?<![A-Za-z])(?:mailto|tel|sms|intent|market|https|javascript):|(?:^|[^:])\/\//i;

function remoteHabitName(value) {
  if (REMOTE_HABIT.test(value)) return true;
  const decoded = decodePercent(value);
  return decoded !== value && REMOTE_HABIT.test(decoded);
}

function createHabitStore(rootDirectory, ipcMain, options = {}) {
  const file = path.join(rootDirectory, '.loam-habits.json');
  const now = options.now ?? (() => new Date());
  const notify = options.notify ?? (() => undefined);
  const notified = new Set();

  function read() {
    const data = readJson(file, { habits: [] });
    return Array.isArray(data.habits) ? data.habits : [];
  }

  function list() {
    const today = now();
    const todayKey = dateKey(today);
    const week = new Date(today);
    week.setDate(week.getDate() - 6);
    return read().map((habit) => ({
      ...habit,
      streak: streak(habit.completions, today),
      completedToday: habit.completions.includes(todayKey),
      weeklyCompletions: habit.completions.filter((date) => date >= dateKey(week) && date <= todayKey).length,
    }));
  }

  function add(input) {
    const habits = read();
    const reminder = String(input.reminder ?? '09:00');
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(reminder)) throw new Error('Invalid reminder time');
    const days = Array.isArray(input.days) ? [...new Set(input.days.map(Number))].filter((day) => Number.isInteger(day) && day >= 0 && day <= 6).sort() : [1, 2, 3, 4, 5];
    if (days.length === 0) throw new Error('Choose at least one reminder day');
    const name = text(input.name, 'habit name');
    if (remoteHabitName(name)) throw new Error('Invalid habit name');
    habits.push({ id: randomUUID(), name, reminder, days, completions: [] });
    writeJsonAtomic(file, { habits });
    return list();
  }

  function complete(id) {
    const habits = read();
    const habit = habits.find((candidate) => candidate.id === id);
    if (!habit) throw new Error('Habit not found');
    const today = dateKey(now());
    if (!habit.completions.includes(today)) habit.completions.push(today);
    habit.completions.sort();
    writeJsonAtomic(file, { habits });
    return list();
  }

  function checkReminders() {
    const current = now();
    const time = `${String(current.getHours()).padStart(2, '0')}:${String(current.getMinutes()).padStart(2, '0')}`;
    const key = dateKey(current);
    for (const habit of read()) {
      const notificationKey = `${habit.id}:${key}:${habit.reminder}`;
      if (habit.reminder === time && habit.days.includes(current.getDay()) && !habit.completions.includes(key) && !notified.has(notificationKey)) {
        notified.add(notificationKey);
        notify(habit);
      }
    }
  }

  ipcMain?.handle('habits:list', () => list());
  ipcMain?.handle('habits:add', (_event, input) => add(input));
  ipcMain?.handle('habits:complete', (_event, id) => complete(id));
  return { list, add, complete, checkReminders, startReminders: () => { checkReminders(); const timer = setInterval(checkReminders, 30_000); timer.unref(); return timer; } };
}

module.exports = { createHabitStore, dateKey, streak };
