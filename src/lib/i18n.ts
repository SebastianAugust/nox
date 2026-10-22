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
  "date.late": "{n}d late",
  "tag.overdue": "Overdue",
  "tag.personal": "Personal",
  "tag.reminder": "Reminder",

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
  "sub.integrations": "Services Nox will connect to",
  "sub.settings": "Nox preferences",

  // ── Home ──
  "home.greet.morning": "Morning, {name}",
  "home.greet.afternoon": "Afternoon, {name}",
  "home.greet.evening": "Evening, {name}",
  "home.greet.night": "Late night, {name}",
  "home.msg.overdue": "{title} is {n} days overdue. Want to work on it for {min} minutes now? I'll keep everything else quiet.",
  "home.msg.overdueOne": "{title} was due yesterday. Want to work on it for {min} minutes now? I'll keep everything else quiet.",
  "home.msg.today": "{title} is due today. Want to give it {min} focused minutes now?",
  "home.msg.habits": "{n} habits are still open today. A small step counts too.",
  "home.msg.habitsOne": "One habit is still open today. A small step counts too.",
  "home.msg.idle": "All quiet. Nothing overdue and nothing due today. Add a todo whenever something comes up.",
  "home.startFocus": "Start focus · {min} min",
  "home.todosOpen": "todos open",
  "home.overdueCount": "{n} overdue",
  "home.focusSessions": "focus sessions",
  "home.habitsDone": "habits done",
  "home.today": "Today",
  "home.openCount": "{n} open",
  "home.todayEmpty": "Nothing due today. Add one below, or enjoy the quiet.",
  "home.focusOf": "{n} of {goal} sessions today",
  "home.todayShort": "Today",
  "home.next7": "Next 7 days",
  "home.next7Meta": "Todos · reminders",

  // ── Habits ──
  "habits.today": "today",
  "habits.empty": "No habits yet. Add one below, like “drink water”, and tick it off each day.",
  "habits.new": "Add a habit…",
  "habits.streak": "day streak",
  "habits.best": "best streak",
  "habits.add": "+ add habit",
  "habits.toggle": "Toggle",
  "habits.delete": "Delete habit",
  "habits.confirmDelete": "delete?",
  "habits.week": "last 7 days",
  "habits.streakLine": "Streak {n} days · best {best}",
  "habits.streakHint": "A day counts once any habit is done.",
  "habits.addLabel": "Add a habit",
  "habits.bestShort": "best {n}",
  "habits.state.done": "done",
  "habits.state.today": "not yet",
  "habits.state.missed": "missed",

  // ── Pomodoro ──
  "pom.ready": "Ready",
  "pom.focusTime": "Focus time",
  "pom.breakTime": "Break time",
  "pom.ringFocus": "Focusing",
  "pom.ringBreak": "Break",
  "pom.ringReady": "Ready",
  "pom.session": "{count} session today",
  "pom.sessions": "{count} sessions today",
  "pom.start": "Start",
  "pom.stop": "Stop",
  "pom.skip": "Skip break",
  "pom.todaySessions": "Today's sessions",
  "pom.durations": "Focus {focus} min · break {rest} min",
  "pom.none": "No sessions yet today. Start one above; it keeps running even if you close this window.",
  "pom.completed": "Completed · {min} min",
  "pom.stopped": "Stopped early · {min} min",

  // ── Todos ──
  "todos.active": "Active",
  "todos.done": "Done",
  "todos.all": "All",
  "todos.emptyActive": "No open todos. Add one above, or from the pet with /todo.",
  "todos.emptyDone": "Nothing done yet. Ticked todos show up here.",
  "todos.empty": "No todos yet. Add one above, or from the pet with /todo.",
  "todos.filter": "Show",
  "todos.placeholder": "Todo title...",
  "todos.addButton": "Add",
  "todos.cancel": "Cancel",
  "todos.add": "+ add todo",
  "todos.addLabel": "Add a todo",
  "todos.addPlaceholder": "Add a todo… try “tomorrow” or “25/12”",
  "todos.reminder": "reminder · ",
  "todos.toggle": "Toggle",
  "todos.delete": "Delete todo",
  "reminders.title": "Reminders",
  "reminders.empty": "No reminders. Set one from the pet: /remind standup at 09:00",
  "reminders.sent": "sent",
  "reminders.delete": "Delete reminder",

  // ── Recap ──
  "common.loading": "Loading…",
  "recap.empty": "No recaps yet. The first one arrives at {time}.",
  "recap.tasks": "tasks",
  "recap.pomodoros": "focus sessions",
  "recap.habits": "habits",

  // ── Integrations ──
  "int.lead": "Connections that will feed Nox. None of them is built yet; each one shows its status here.",
  "int.planned": "Planned",
  "int.connected": "Connected",
  "int.notConnected": "Not connected",
  "int.notion": "Assignments and deadlines from your Notion database, next to your todos.",
  "int.calendar": "Today's events, so Nox knows when you are busy.",
  "int.music": "Focus music that starts with a session.",
  "int.weather": "Rain warnings for your location. No account needed.",

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
  "date.late": "telat {n} hr",
  "tag.overdue": "Terlambat",
  "tag.personal": "Pribadi",
  "tag.reminder": "Pengingat",

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
  "sub.integrations": "Layanan yang akan terhubung ke Nox",
  "sub.settings": "Preferensi Nox",

  "home.greet.morning": "Pagi, {name}",
  "home.greet.afternoon": "Siang, {name}",
  "home.greet.evening": "Malam, {name}",
  "home.greet.night": "Sudah larut, {name}",
  "home.msg.overdue": "{title} sudah telat {n} hari. Mau dikerjakan {min} menit sekarang? Yang lain aku buat senyap.",
  "home.msg.overdueOne": "{title} tenggatnya kemarin. Mau dikerjakan {min} menit sekarang? Yang lain aku buat senyap.",
  "home.msg.today": "{title} tenggatnya hari ini. Mau fokus {min} menit sekarang?",
  "home.msg.habits": "Masih ada {n} kebiasaan yang belum hari ini. Langkah kecil juga dihitung.",
  "home.msg.habitsOne": "Masih ada satu kebiasaan yang belum hari ini. Langkah kecil juga dihitung.",
  "home.msg.idle": "Semua tenang. Tidak ada yang telat atau tenggat hari ini. Tambah tugas kapan saja.",
  "home.startFocus": "Mulai fokus · {min} mnt",
  "home.todosOpen": "tugas terbuka",
  "home.overdueCount": "{n} terlambat",
  "home.focusSessions": "sesi fokus",
  "home.habitsDone": "kebiasaan selesai",
  "home.today": "Hari ini",
  "home.openCount": "{n} terbuka",
  "home.todayEmpty": "Tidak ada tenggat hari ini. Tambah di bawah, atau nikmati tenangnya.",
  "home.focusOf": "{n} dari {goal} sesi hari ini",
  "home.todayShort": "Hari ini",
  "home.next7": "7 hari ke depan",
  "home.next7Meta": "Tugas · pengingat",

  "habits.today": "hari ini",
  "habits.empty": "Belum ada kebiasaan. Tambahkan di bawah, misalnya “minum air”, lalu centang tiap hari.",
  "habits.new": "Tambah kebiasaan…",
  "habits.streak": "hari beruntun",
  "habits.best": "rekor beruntun",
  "habits.add": "+ tambah kebiasaan",
  "habits.toggle": "Centang",
  "habits.delete": "Hapus kebiasaan",
  "habits.confirmDelete": "hapus?",
  "habits.week": "7 hari terakhir",
  "habits.streakLine": "Beruntun {n} hari · rekor {best}",
  "habits.streakHint": "Satu hari dihitung begitu ada kebiasaan yang selesai.",
  "habits.addLabel": "Tambah kebiasaan",
  "habits.bestShort": "rekor {n}",
  "habits.state.done": "selesai",
  "habits.state.today": "belum",
  "habits.state.missed": "terlewat",

  "pom.ready": "Siap",
  "pom.focusTime": "Waktu fokus",
  "pom.breakTime": "Waktu istirahat",
  "pom.ringFocus": "Sedang fokus",
  "pom.ringBreak": "Istirahat",
  "pom.ringReady": "Siap",
  "pom.session": "{count} sesi hari ini",
  "pom.sessions": "{count} sesi hari ini",
  "pom.start": "Mulai",
  "pom.stop": "Berhenti",
  "pom.skip": "Lewati istirahat",
  "pom.todaySessions": "Sesi hari ini",
  "pom.durations": "Fokus {focus} menit · istirahat {rest} menit",
  "pom.none": "Belum ada sesi hari ini. Mulai di atas; tetap jalan walau jendela ini ditutup.",
  "pom.completed": "Selesai · {min} menit",
  "pom.stopped": "Berhenti lebih awal · {min} menit",

  "todos.active": "Aktif",
  "todos.done": "Selesai",
  "todos.all": "Semua",
  "todos.emptyActive": "Tidak ada tugas terbuka. Tambah di atas, atau dari Nox dengan /todo.",
  "todos.emptyDone": "Belum ada yang selesai. Tugas yang dicentang muncul di sini.",
  "todos.empty": "Belum ada tugas. Tambah di atas, atau dari Nox dengan /todo.",
  "todos.filter": "Tampilkan",
  "todos.placeholder": "Judul tugas...",
  "todos.addButton": "Tambah",
  "todos.cancel": "Batal",
  "todos.add": "+ tambah tugas",
  "todos.addLabel": "Tambah tugas",
  "todos.addPlaceholder": "Tambah tugas… coba “besok” atau “25/12”",
  "todos.reminder": "pengingat · ",
  "todos.toggle": "Centang",
  "todos.delete": "Hapus tugas",
  "reminders.title": "Pengingat",
  "reminders.empty": "Belum ada pengingat. Pasang dari Nox: /remind standup jam 09:00",
  "reminders.sent": "terkirim",
  "reminders.delete": "Hapus pengingat",

  "common.loading": "Memuat…",
  "recap.empty": "Belum ada rekap. Yang pertama datang pukul {time}.",
  "recap.tasks": "tugas",
  "recap.pomodoros": "sesi fokus",
  "recap.habits": "kebiasaan",

  "int.lead": "Koneksi yang nanti akan mengisi Nox. Belum ada yang dibuat; statusnya tampil di sini.",
  "int.planned": "Direncanakan",
  "int.connected": "Terhubung",
  "int.notConnected": "Belum terhubung",
  "int.notion": "Tugas kuliah dan tenggat dari database Notion, di samping daftar tugasmu.",
  "int.calendar": "Acara hari ini, supaya Nox tahu kapan kamu sibuk.",
  "int.music": "Musik fokus yang mulai bersama sesi.",
  "int.weather": "Peringatan hujan untuk lokasimu. Tanpa akun.",

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
