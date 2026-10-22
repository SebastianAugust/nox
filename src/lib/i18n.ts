import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getSetting } from "./db-helpers";

/**
 * UI strings for both windows. The `language` setting picks the dictionary; it
 * is cached here and re-read whenever the dashboard broadcasts
 * "settings:changed" after a settings write.
 */

export type Lang = "en" | "id";

const en = {
  // ── Pet window ──
  "pet.greeting": "Hey! I'm Nox.",
  "pet.title": "Click to chat with Nox",
  "pet.thinking": "...",
  "pet.focus": "Focus mode. Timer's running.",
  "pet.break": "Break time. Get up, stretch.",
  "pet.checkinAsk": "How's the body doing?",
  "pet.friction": "Quiet for a while. What are you working on, {name}?",
  "pet.recap": "Day recap: {summary}. Good work today, {name}!",
  "pet.reminder": "Reminder: {titles}",
  "pet.reminders": "Reminders: {titles}",
  "pet.remindersMissed": "You missed {n} reminders. They're listed in the dashboard under Todos.",
  "pet.checkin.tired": "Rest up, {name}. Tasks can wait.",
  "pet.checkin.hungry": "Go eat first. I'll be here.",
  "pet.checkin.other": "Got it. Keep going.",
  "pet.stop": "Stop",
  "pet.startFocus": "Start focus",
  "pet.later": "Later",
  "chat.placeholder": "Talk to Nox… or /todo",
  "chat.label": "Message Nox",
  "chat.commandHint": "try /todo <task>, /remind <thing>, /clear or /dashboard",
  "chat.send": "Send",
  "checkin.question": "How are you right now?",
  "checkin.notNow": "Not now",
  "mood.good": "Good",
  "mood.ok": "Ok",
  "mood.tired": "Tired",
  "mood.hungry": "Hungry",
  "cmd.todo.empty": 'Needs something to save. Try "/todo buy coffee tomorrow".',
  "cmd.todo.onlyDate": "That's only a date. What should I call it?",
  "cmd.todo.addedDue": 'Added: "{title}" · due {due}.',
  "cmd.todo.added": 'Added: "{title}" to your todos.',
  "cmd.remind.empty": 'Needs something to save. Try "/remind standup at 09:00".',
  "cmd.remind.set": 'Reminder set: "{title}" · {when}.',
  "cmd.remind.tomorrowAt": "tomorrow {clock}",
  "cmd.remind.asTodo": 'Saved "{title}" as a todo. Add "at 09:00" for a time.',
  "cmd.saveFailed": "Couldn't save that. Check the database.",
  "cmd.help": "/todo <task> [today | tomorrow | 25/12] · /remind <thing> at 09:00 · /clear · /dashboard",
  "cmd.unknown": "No such command. Try /todo, /remind, /clear, /dashboard or /help.",
  "cmd.clear.done": "Fresh start. I've forgotten our chat.",
  "ollama.timeout": "Taking too long... try a shorter question.",
  "ollama.cutOff": "(cut off)",
  "ollama.modelMissing": "Model not loaded. Run `ollama pull {model}`.",
  "ollama.error": "Ollama error ({status}). Try again.",
  "ollama.failed": "Something went wrong. Try again.",
  "ollama.unreachable": "Can't reach Ollama. Is it running?",
  "recap.summary": "{done}/{total} tasks done · {pomodoros} pomodoros · {habitsDone}/{habitsTotal} habits",

  // ── Shared date words ──
  "date.today": "today",
  "date.tomorrow": "tomorrow",
  "date.overdue": "overdue",

  // ── Dashboard shell ──
  "dash.minimize": "Minimize",
  "dash.close": "Close",
  "dash.nav": "Main",
  "nav.home": "Home",
  "nav.habits": "Habits",
  "nav.pomodoro": "Focus",
  "nav.todos": "Todos",
  "nav.recap": "Recap",
  "nav.integrations": "Integrations",
  "nav.settings": "Settings",
  "sub.habits": "Daily habits",
  "sub.pomodoro": "Focus without distractions",
  "sub.todos": "All tasks",
  "sub.recap": "Daily history",
  "sub.integrations": "Manage connections",
  "sub.settings": "Nox preferences",

  // ── Overview ──
  "home.petState": "Nox · idle",
  "home.paused": "Paused while dashboard is open",
  "home.pausedTag": "paused",
  "home.tasksToday": "tasks today",
  "home.pomodoros": "pomodoros",
  "home.habitsDone": "habits done",
  "home.deadlineToday": "deadline today",
  "home.deadlinesToday": "deadlines today",
  "home.upcoming": "upcoming",
  "home.nothing": "Nothing scheduled. Capture one with /todo.",

  // ── Habits ──
  "habits.today": "today",
  "habits.empty": "No habits yet. Add one below.",
  "habits.new": "New habit...",
  "habits.streak": "day streak",
  "habits.best": "best streak",
  "habits.add": "+ add habit",
  "habits.toggle": "Toggle",
  "habits.delete": "Delete habit",
  "habits.confirmDelete": "delete?",
  "habits.week": "last 7 days",

  // ── Pomodoro ──
  "pom.ready": "Ready",
  "pom.focusTime": "Focus time",
  "pom.breakTime": "Break time",
  "pom.ringFocus": "focus",
  "pom.ringBreak": "break",
  "pom.ringReady": "ready",
  "pom.session": "{count} session today",
  "pom.sessions": "{count} sessions today",
  "pom.start": "Start",
  "pom.stop": "Stop",
  "pom.skip": "Skip break",
  "pom.todaySessions": "today's sessions",
  "pom.none": "No sessions yet today.",
  "pom.completed": "Completed · {min} min",
  "pom.stopped": "Stopped early · {min} min",

  // ── Todos ──
  "todos.active": "Active",
  "todos.done": "Done",
  "todos.all": "All",
  "todos.emptyActive": "No active todos. Nice.",
  "todos.empty": "Nothing here.",
  "todos.placeholder": "Todo title...",
  "todos.addButton": "Add",
  "todos.cancel": "Cancel",
  "todos.add": "+ add todo",
  "todos.reminder": "reminder · ",
  "todos.toggle": "Toggle",
  "todos.delete": "Delete todo",
  "reminders.title": "reminders",
  "reminders.empty": "No reminders. Set one from the pet: /remind standup at 09:00",
  "reminders.sent": "sent",
  "reminders.delete": "Delete reminder",

  // ── Recap ──
  "common.loading": "Loading…",
  "recap.empty": "No recaps yet. The first one lands at your recap time.",
  "recap.tasks": "tasks",
  "recap.pomodoros": "pomodoros",
  "recap.habits": "habits",

  // ── Integrations ──
  "int.services": "services",
  "int.noToken": "no token needed, just enable",
  "int.on": "on",
  "int.enable": "enable",
  "int.setup": "setup",
  "int.comingSoon": "Coming soon. This integration will be set up here.",

  // ── Settings ──
  "set.general": "general",
  "set.features": "features",
  "set.timing": "timing",
  "set.language": "Language",
  "set.userName": "User name",
  "set.location": "Location",
  "set.model": "Ollama model",
  "set.timezone": "Timezone",
  "set.checkin": "Body check-in",
  "set.dnd": "Quiet during pomodoro",
  "set.friction": "Friction starter",
  "set.autostart": "Start with Windows",
  "set.recapTime": "Day recap",
  "set.pomDuration": "Pomodoro duration",
  "set.breakDuration": "Break duration",
  "set.checkinEvery": "Check-in every",
  "set.minutes": "{n} min",
  "set.clickToEdit": "Click to edit",
  "set.shortcuts": "Shortcuts: 1-{n} switch pages · Esc closes this window.",
} as const;

export type I18nKey = keyof typeof en;

const id: Record<I18nKey, string> = {
  "pet.greeting": "Hai! Aku Nox.",
  "pet.title": "Klik untuk ngobrol dengan Nox",
  "pet.thinking": "...",
  "pet.focus": "Mode fokus. Timer jalan.",
  "pet.break": "Waktunya istirahat. Berdiri, peregangan.",
  "pet.checkinAsk": "Gimana kabar badanmu?",
  "pet.friction": "Sepi dari tadi. Lagi ngerjain apa, {name}?",
  "pet.recap": "Rekap hari ini: {summary}. Kerja bagus, {name}!",
  "pet.reminder": "Pengingat: {titles}",
  "pet.reminders": "Pengingat: {titles}",
  "pet.remindersMissed": "Kamu melewatkan {n} pengingat. Daftarnya ada di dashboard, bagian Tugas.",
  "pet.checkin.tired": "Istirahat dulu, {name}. Tugas bisa nunggu.",
  "pet.checkin.hungry": "Makan dulu sana. Aku tunggu di sini.",
  "pet.checkin.other": "Oke. Lanjut terus.",
  "pet.stop": "Berhenti",
  "pet.startFocus": "Mulai fokus",
  "pet.later": "Nanti",
  "chat.placeholder": "Ngobrol dengan Nox… atau /todo",
  "chat.label": "Pesan untuk Nox",
  "chat.commandHint": "coba /todo <tugas>, /remind <hal>, /clear atau /dashboard",
  "chat.send": "Kirim",
  "checkin.question": "Gimana kondisimu sekarang?",
  "checkin.notNow": "Nanti saja",
  "mood.good": "Baik",
  "mood.ok": "Biasa",
  "mood.tired": "Capek",
  "mood.hungry": "Lapar",
  "cmd.todo.empty": 'Belum ada yang disimpan. Coba "/todo beli kopi besok".',
  "cmd.todo.onlyDate": "Itu cuma tanggal. Mau dikasih nama apa?",
  "cmd.todo.addedDue": 'Ditambahkan: "{title}" · tenggat {due}.',
  "cmd.todo.added": 'Ditambahkan: "{title}" ke daftar tugas.',
  "cmd.remind.empty": 'Belum ada yang disimpan. Coba "/remind standup jam 09:00".',
  "cmd.remind.set": 'Pengingat dipasang: "{title}" · {when}.',
  "cmd.remind.tomorrowAt": "besok {clock}",
  "cmd.remind.asTodo": 'Disimpan "{title}" sebagai tugas. Tambahkan "jam 09:00" untuk waktunya.',
  "cmd.saveFailed": "Gagal menyimpan. Cek databasenya.",
  "cmd.help": "/todo <tugas> [hari ini | besok | 25/12] · /remind <hal> jam 09:00 · /clear · /dashboard",
  "cmd.unknown": "Perintah tidak dikenal. Coba /todo, /remind, /clear, /dashboard atau /help.",
  "cmd.clear.done": "Mulai dari awal. Obrolan kita sudah kulupakan.",
  "ollama.timeout": "Kelamaan... coba pertanyaan yang lebih pendek.",
  "ollama.cutOff": "(terpotong)",
  "ollama.modelMissing": "Model belum dimuat. Jalankan `ollama pull {model}`.",
  "ollama.error": "Ollama error ({status}). Coba lagi.",
  "ollama.failed": "Ada yang salah. Coba lagi.",
  "ollama.unreachable": "Ollama tidak bisa dihubungi. Sudah jalan?",
  "recap.summary": "{done}/{total} tugas selesai · {pomodoros} pomodoro · {habitsDone}/{habitsTotal} kebiasaan",

  "date.today": "hari ini",
  "date.tomorrow": "besok",
  "date.overdue": "terlambat",

  "dash.minimize": "Perkecil",
  "dash.close": "Tutup",
  "dash.nav": "Utama",
  "nav.home": "Beranda",
  "nav.habits": "Kebiasaan",
  "nav.pomodoro": "Fokus",
  "nav.todos": "Tugas",
  "nav.recap": "Rekap",
  "nav.integrations": "Integrasi",
  "nav.settings": "Pengaturan",
  "sub.habits": "Kebiasaan harian",
  "sub.pomodoro": "Fokus tanpa gangguan",
  "sub.todos": "Semua tugas",
  "sub.recap": "Riwayat harian",
  "sub.integrations": "Kelola koneksi",
  "sub.settings": "Preferensi Nox",

  "home.petState": "Nox · santai",
  "home.paused": "Dijeda selama dashboard terbuka",
  "home.pausedTag": "dijeda",
  "home.tasksToday": "tugas hari ini",
  "home.pomodoros": "pomodoro",
  "home.habitsDone": "kebiasaan selesai",
  "home.deadlineToday": "tenggat hari ini",
  "home.deadlinesToday": "tenggat hari ini",
  "home.upcoming": "mendatang",
  "home.nothing": "Belum ada jadwal. Catat satu dengan /todo.",

  "habits.today": "hari ini",
  "habits.empty": "Belum ada kebiasaan. Tambahkan di bawah.",
  "habits.new": "Kebiasaan baru...",
  "habits.streak": "hari beruntun",
  "habits.best": "rekor beruntun",
  "habits.add": "+ tambah kebiasaan",
  "habits.toggle": "Centang",
  "habits.delete": "Hapus kebiasaan",
  "habits.confirmDelete": "hapus?",
  "habits.week": "7 hari terakhir",

  "pom.ready": "Siap",
  "pom.focusTime": "Waktu fokus",
  "pom.breakTime": "Waktu istirahat",
  "pom.ringFocus": "fokus",
  "pom.ringBreak": "istirahat",
  "pom.ringReady": "siap",
  "pom.session": "{count} sesi hari ini",
  "pom.sessions": "{count} sesi hari ini",
  "pom.start": "Mulai",
  "pom.stop": "Berhenti",
  "pom.skip": "Lewati istirahat",
  "pom.todaySessions": "sesi hari ini",
  "pom.none": "Belum ada sesi hari ini.",
  "pom.completed": "Selesai · {min} menit",
  "pom.stopped": "Berhenti lebih awal · {min} menit",

  "todos.active": "Aktif",
  "todos.done": "Selesai",
  "todos.all": "Semua",
  "todos.emptyActive": "Tidak ada tugas aktif. Mantap.",
  "todos.empty": "Kosong.",
  "todos.placeholder": "Judul tugas...",
  "todos.addButton": "Tambah",
  "todos.cancel": "Batal",
  "todos.add": "+ tambah tugas",
  "todos.reminder": "pengingat · ",
  "todos.toggle": "Centang",
  "todos.delete": "Hapus tugas",
  "reminders.title": "pengingat",
  "reminders.empty": "Belum ada pengingat. Pasang dari Nox: /remind standup jam 09:00",
  "reminders.sent": "terkirim",
  "reminders.delete": "Hapus pengingat",

  "common.loading": "Memuat…",
  "recap.empty": "Belum ada rekap. Yang pertama muncul di jam rekapmu.",
  "recap.tasks": "tugas",
  "recap.pomodoros": "pomodoro",
  "recap.habits": "kebiasaan",

  "int.services": "layanan",
  "int.noToken": "tidak perlu token, cukup aktifkan",
  "int.on": "aktif",
  "int.enable": "aktifkan",
  "int.setup": "atur",
  "int.comingSoon": "Segera hadir. Integrasi ini akan diatur di sini.",

  "set.general": "umum",
  "set.features": "fitur",
  "set.timing": "waktu",
  "set.language": "Bahasa",
  "set.userName": "Nama pengguna",
  "set.location": "Lokasi",
  "set.model": "Model Ollama",
  "set.timezone": "Zona waktu",
  "set.checkin": "Cek kondisi badan",
  "set.dnd": "Senyap saat pomodoro",
  "set.friction": "Pemicu mulai",
  "set.autostart": "Jalan saat Windows mulai",
  "set.recapTime": "Rekap harian",
  "set.pomDuration": "Durasi pomodoro",
  "set.breakDuration": "Durasi istirahat",
  "set.checkinEvery": "Cek kondisi tiap",
  "set.minutes": "{n} menit",
  "set.clickToEdit": "Klik untuk ubah",
  "set.shortcuts": "Pintasan: 1-{n} pindah halaman · Esc menutup jendela ini.",
};

const dictionaries: Record<Lang, Record<I18nKey, string>> = { en, id };

let current: Lang = "en";
const listeners = new Set<(lang: Lang) => void>();

export function getLang(): Lang {
  return current;
}

/** BCP 47 locale for dates and numbers, following the language setting. */
export function locale(): string {
  return current === "id" ? "id-ID" : "en-US";
}

export function t(key: I18nKey, params?: Record<string, string | number>): string {
  const text = dictionaries[current][key];
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, name) =>
    name in params ? String(params[name]) : m,
  );
}

async function loadLanguage(): Promise<void> {
  const next: Lang = (await getSetting("language")) === "id" ? "id" : "en";
  if (next === current) return;
  current = next;
  listeners.forEach((fn) => fn(current));
}

/**
 * Load the language and follow later changes. Call once per window; returns a
 * stop function.
 */
export function startI18n(): () => void {
  loadLanguage().catch(console.error);
  const unlisten = listen("settings:changed", () => {
    loadLanguage().catch(console.error);
  });
  return () => {
    unlisten.then((off) => off()).catch(console.error);
  };
}

/**
 * Re-render on language change. Use it once at each window's root: children
 * re-render with it and read the new strings through t().
 */
export function useLanguage(): Lang {
  const [lang, setLang] = useState(current);
  useEffect(() => {
    listeners.add(setLang);
    setLang(current);
    const stop = startI18n();
    return () => {
      listeners.delete(setLang);
      stop();
    };
  }, []);
  return lang;
}
