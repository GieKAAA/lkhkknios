import * as Notifications from "expo-notifications";

/**
 * Local (on-device) reminder notifications nudging the user to fill in
 * today's LKH attendance if they haven't yet, at 10:00 and 20:00.
 *
 * Expo's local notification triggers can't run conditional logic at fire
 * time, so "only if not yet absen" is approximated by (re)scheduling these
 * as one-off notifications for *today* every time
 * scheduleDailyAttendanceReminders() runs - call it on app load and right
 * after attendance is saved. Already-passed times are skipped, and both
 * reminders are cancelled outright once today's attendance is saved. This
 * means a fresh day's reminders only get (re)armed once the app is opened
 * that day - there's no true background daily scheduling without a
 * push/background-task server, which is out of scope here.
 */

const MORNING_REMINDER_ID = "lkh-attendance-reminder-morning";
const EVENING_REMINDER_ID = "lkh-attendance-reminder-evening";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function requestNotificationPermissions(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  const requested = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowBadge: true, allowSound: true },
  });
  return !!requested.granted;
}

function todayAt(hour: number, minute: number): Date {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date;
}

/**
 * (Re)schedules today's 10:00/20:00 attendance reminders, skipping times
 * that already passed and skipping entirely if `hasAttendedToday` is true.
 * Call this on app load and right after a successful attendance save.
 */
export async function scheduleDailyAttendanceReminders(
  hasAttendedToday: boolean,
): Promise<void> {
  await Notifications.cancelScheduledNotificationAsync(MORNING_REMINDER_ID).catch(() => {});
  await Notifications.cancelScheduledNotificationAsync(EVENING_REMINDER_ID).catch(() => {});

  if (hasAttendedToday) return;

  const granted = await requestNotificationPermissions();
  if (!granted) return;

  const now = new Date();
  const morning = todayAt(10, 0);
  const evening = todayAt(20, 0);

  if (morning > now) {
    await Notifications.scheduleNotificationAsync({
      identifier: MORNING_REMINDER_ID,
      content: {
        title: "Belum Absen LKH",
        body: "Jangan lupa isi laporan dan foto absensi hari ini ya!",
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: morning,
      },
    });
  }

  if (evening > now) {
    await Notifications.scheduleNotificationAsync({
      identifier: EVENING_REMINDER_ID,
      content: {
        title: "Belum Absen LKH",
        body: "Hari sudah malam dan kamu belum absen LKH hari ini. Segera isi sebelum lupa!",
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: evening,
      },
    });
  }
}
