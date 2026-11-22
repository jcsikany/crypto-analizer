// ─── Push Notification Sender v2 — Enhanced Context ──────────────────────────
const { Expo } = require('expo-server-sdk');
const { canSendAlert, logAlert, removeDevice, getAlertConfig } = require('./database');

const expo = new Expo();

// ─── Emoji + labels por zona y señal ─────────────────────────────────────────

const ZONE_LABELS = {
  ACCUMULATION: '📈 Zona de Acumulación',
  DISTRIBUTION: '📉 Zona de Distribución',
  NEUTRAL:      '⚖️ Zona Neutral',
};

// ─── Evaluar si debe notificar y enviar ──────────────────────────────────────

async function evaluateAndNotify(devices, masterSignal, asset) {
  if (!masterSignal) return;

  const { score, confidence, signal, zone, regime, confluence } = masterSignal;
  const priceStr = masterSignal.price
    ? `$${Math.round(masterSignal.price).toLocaleString('en-US')}`
    : '';

  const notifications = [];

  for (const device of devices) {
    if (device.asset !== asset) continue;

    const config = getAlertConfig(device.push_token);
    if (!config.enabled) continue;
    if (!Expo.isExpoPushToken(device.push_token)) {
      console.warn(`Token inválido: ${device.push_token}`);
      continue;
    }

    let alertType = null;
    let msgTitle  = '';
    let msgBody   = '';

    // ── COMPRA FUERTE ────────────────────────────────────────────────
    if (score >= config.strongThreshold && confluence.ratio >= 0.5) {
      alertType = 'STRONG_BUY';
      msgTitle  = `🟢 ${asset}: COMPRA FUERTE`;
      msgBody   = `Score: +${score.toFixed(2)} | Conf: ${confidence}% | ${priceStr}\n` +
                  `Confluencia: ${Math.round(confluence.ratio * 100)}% | ${regime}`;
      if (masterSignal.fundamental?.fearGreed !== null) {
        msgBody += `\nF&G: ${masterSignal.fundamental.fearGreed}`;
      }
    }
    // ── VENTA FUERTE ─────────────────────────────────────────────────
    else if (score <= -config.strongThreshold && confluence.ratio >= 0.5) {
      alertType = 'STRONG_SELL';
      msgTitle  = `🔴 ${asset}: VENTA FUERTE`;
      msgBody   = `Score: ${score.toFixed(2)} | Conf: ${confidence}% | ${priceStr}\n` +
                  `Confluencia: ${Math.round(confluence.ratio * 100)}% | ${regime}`;
    }
    // ── COMPRA MODERADA ──────────────────────────────────────────────
    else if (score >= config.moderateThreshold && score < config.strongThreshold && confluence.ratio >= 0.5) {
      alertType = 'MODERATE_BUY';
      msgTitle  = `🟡 ${asset}: Oportunidad de Compra`;
      msgBody   = `Score: +${score.toFixed(2)} | Conf: ${confidence}% | ${priceStr}\n` +
                  `${ZONE_LABELS[zone] || zone} | ${regime}`;
    }
    // ── CAMBIO DE ZONA A ACUMULACIÓN ─────────────────────────────────
    else if (zone === 'ACCUMULATION' && score > 0) {
      alertType = 'ZONE_ACCUMULATION';
      msgTitle  = `📈 ${asset}: Zona de Acumulación`;
      msgBody   = `Score: +${score.toFixed(2)} | ${priceStr} — Posible momento de compra`;
    }

    if (!alertType) continue;

    // Verificar cooldown
    const ok = canSendAlert(device.push_token, asset, alertType, config.cooldownMinutes);
    if (!ok) {
      console.log(`[${asset}] ${alertType} cooldown activo para ...${device.push_token.slice(-8)}`);
      continue;
    }

    notifications.push({
      to:    device.push_token,
      sound: 'default',
      title: msgTitle,
      body:  msgBody,
      data:  {
        type: alertType, asset, score, signal, zone, regime,
        confidence, confluenceRatio: confluence.ratio,
      },
      priority: 'high',
      channelId: 'signal-alerts',
      _meta: { pushToken: device.push_token, asset, alertType, score },
    });
  }

  await sendChunks(notifications);
}

// ─── Alertas de acumulación de largo plazo (BTC, todos los dispositivos) ─────

async function sendAccumulationAlert(devices, alert, evaluation) {
  const asset = 'BTC';
  const score = evaluation.metrics.priceToWma ?? 0;
  const notifications = [];

  for (const device of devices) {
    const config = getAlertConfig(device.push_token);
    if (!config.longTermEnabled) continue;
    if (!Expo.isExpoPushToken(device.push_token)) continue;
    if (!canSendAlert(device.push_token, asset, alert.alertType, alert.cooldownMinutes)) continue;

    notifications.push({
      to:    device.push_token,
      sound: 'default',
      title: alert.title,
      body:  alert.body,
      data:  {
        type: alert.alertType, asset, zone: evaluation.zone,
        asOf: evaluation.asOf, screen: 'Accumulation',
      },
      priority: 'high',
      channelId: 'signal-alerts',
      _meta: { pushToken: device.push_token, asset, alertType: alert.alertType, score },
    });
  }

  await sendChunks(notifications);
}

// ─── Alertas del S&P 500 / CSPX (texto armado por dispositivo) ───────────────

/**
 * @param {object[]} devices
 * @param {(equityConfig: object) => ({alertType,title,body,cooldownMinutes}|null)} buildForConfig
 * @param {object|null} evaluation  estado actual (para datos y score del log)
 */
async function sendEquityNotifications(devices, buildForConfig, evaluation) {
  const asset = 'SPX';
  const score = Number.isFinite(evaluation?.dd) ? evaluation.dd : 0;
  const notifications = [];

  for (const device of devices) {
    const { equity } = getAlertConfig(device.push_token);
    if (!equity.enabled) continue;
    if (!Expo.isExpoPushToken(device.push_token)) continue;
    const alert = buildForConfig(equity);
    if (!alert) continue;
    if (!canSendAlert(device.push_token, asset, alert.alertType, alert.cooldownMinutes)) continue;

    notifications.push({
      to:    device.push_token,
      sound: 'default',
      title: alert.title,
      body:  alert.body,
      data:  { type: alert.alertType, asset, asOf: evaluation?.asOf ?? null, screen: 'Equity' },
      priority: 'high',
      channelId: 'signal-alerts',
      _meta: { pushToken: device.push_token, asset, alertType: alert.alertType, score },
    });
  }

  await sendChunks(notifications);
}

// ─── Envío en chunks + manejo de tickets ─────────────────────────────────────

async function sendChunks(notifications) {
  if (notifications.length === 0) return;

  const chunks = expo.chunkPushNotifications(notifications);
  console.log(`[PUSH] Enviando ${notifications.length} notificacion(es) en ${chunks.length} chunk(s)`);

  for (const chunk of chunks) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);

      tickets.forEach((ticket, i) => {
        const meta = chunk[i]._meta;
        if (ticket.status === 'ok') {
          logAlert(meta.pushToken, meta.asset, meta.alertType, meta.score);
          console.log(`[PUSH ✅] ${meta.asset} ${meta.alertType} → ...${meta.pushToken.slice(-8)}`);
        } else if (ticket.details?.error === 'DeviceNotRegistered') {
          console.warn(`[PUSH ❌] Token inválido, eliminando: ...${meta.pushToken.slice(-8)}`);
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

module.exports = { evaluateAndNotify, sendAccumulationAlert, sendEquityNotifications };
