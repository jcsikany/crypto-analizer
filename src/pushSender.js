// ─── Push Notification Sender ─────────────────────────────────────────────
const { Expo } = require('expo-server-sdk');
const { canSendAlert, logAlert, removeDevice } = require('./database');

const expo = new Expo();

const SIGNAL_LABELS = {
  STRONG_BUY:  { title: '⬆⬆ COMPRA FUERTE',           emoji: '🟢' },
  BUY:         { title: '⬆ Oportunidad de Compra',      emoji: '🟡' },
  STRONG_SELL: { title: '⬇⬇ VENTA FUERTE',             emoji: '🔴' },
};

// ─── Evaluar si debe notificar y enviar ───────────────────────────────────

async function evaluateAndNotify(devices, masterSignal, asset) {
  if (!masterSignal) return;

  const { score, confidence, signal } = masterSignal;
  const priceStr = masterSignal.price
    ? `$${Math.round(masterSignal.price).toLocaleString('en-US')}`
    : '';

  const notifications = [];

  for (const device of devices) {
    if (device.asset !== asset) continue;

    const config = require('./database').getAlertConfig(device.push_token);
    if (!config.enabled) continue;
    if (!Expo.isExpoPushToken(device.push_token)) {
      console.warn(`Token inválido: ${device.push_token}`);
      continue;
    }

    let alertType = null;
    let msgTitle  = '';
    let msgBody   = '';

    // ── COMPRA FUERTE ────────────────────────────────────────────────
    if (score >= config.strongThreshold) {
      alertType = 'STRONG_BUY';
      msgTitle  = `⬆⬆ ${asset}: COMPRA FUERTE`;
      msgBody   = `Score: +${score.toFixed(2)} | Confianza: ${confidence}% | ${priceStr}`;
    }
    // ── VENTA FUERTE ─────────────────────────────────────────────────
    else if (score <= -config.strongThreshold) {
      alertType = 'STRONG_SELL';
      msgTitle  = `⬇⬇ ${asset}: VENTA FUERTE`;
      msgBody   = `Score: ${score.toFixed(2)} | Confianza: ${confidence}% | ${priceStr}`;
    }
    // ── COMPRA MODERADA (largo plazo) ────────────────────────────────
    else if (score >= config.moderateThreshold && score < config.strongThreshold) {
      alertType = 'MODERATE_BUY';
      msgTitle  = `⬆ ${asset}: Oportunidad de Compra`;
      msgBody   = `Score: +${score.toFixed(2)} | Confianza: ${confidence}% | ${priceStr} — Largo plazo`;
    }

    if (!alertType) continue;

    // Verificar cooldown
    const ok = canSendAlert(device.push_token, asset, alertType, config.cooldownMinutes);
    if (!ok) {
      console.log(`[${asset}] ${alertType} cooldown activo para ${device.push_token.slice(-8)}`);
      continue;
    }

    notifications.push({
      to:    device.push_token,
      sound: 'default',
      title: msgTitle,
      body:  msgBody,
      data:  { type: alertType, asset, score, signal },
      priority: 'high',
      channelId: 'signal-alerts',
      _meta: { pushToken: device.push_token, asset, alertType, score },
    });
  }

  if (notifications.length === 0) return;

  // Enviar en chunks (límite de Expo: 100 por batch)
  const chunks = expo.chunkPushNotifications(notifications);
  console.log(`[PUSH] Enviando ${notifications.length} notificacion(es) en ${chunks.length} chunk(s)`);

  for (const chunk of chunks) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);

      tickets.forEach((ticket, i) => {
        const meta = chunk[i]._meta;
        if (ticket.status === 'ok') {
          // Registrar en log para cooldown
          logAlert(meta.pushToken, meta.asset, meta.alertType, meta.score);
          console.log(`[PUSH ✅] ${meta.asset} ${meta.alertType} → ${meta.pushToken.slice(-8)}`);
        } else if (ticket.details?.error === 'DeviceNotRegistered') {
          // Token inválido — eliminar del sistema
          console.warn(`[PUSH ❌] Token inválido, eliminando: ${meta.pushToken.slice(-8)}`);
          removeDevice(meta.pushToken);
        } else {
          console.error(`[PUSH ❌] Error: ${ticket.message}`, ticket.details);
        }
      });
    } catch (err) {
      console.error('[PUSH] Error enviando chunk:', err.message);
    }
  }
}

module.exports = { evaluateAndNotify };
