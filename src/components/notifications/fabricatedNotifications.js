// Older builds wrote alerts from Math.random(): no market event sits behind them.
// Those generators are gone, but their rows can still be in the Notification
// store, so they are kept out of every list and unread count.
const RANDOM_MESSAGES = /^(Unusual volume spike detected for |High volatility detected for )/;

export function isFabricatedNotification(notification) {
  if (notification?.notification_type === 'ai_anomaly'
    && notification.title === 'Unusual Market Activity Detected') {
    return true;
  }
  return RANDOM_MESSAGES.test(notification?.message ?? '');
}

export const withoutFabricated = (notifications) =>
  notifications.filter((n) => !isFabricatedNotification(n));
