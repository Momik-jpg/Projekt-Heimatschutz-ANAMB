// Schlanker SMTP-Versand über nodemailer. nodemailer wird bewusst erst beim
// tatsächlichen Senden dynamisch geladen, damit die Anwendung auch ohne aktive
// E-Mail-Konfiguration (und in Tests mit injiziertem Versand) lauffähig bleibt.
function normalize(value) {
  return String(value ?? "").trim();
}

export function createMailService({ getConfig, logger = console } = {}) {
  function readConfig() {
    const base = typeof getConfig === "function" ? getConfig() ?? {} : {};
    const port = Number(base.port ?? process.env.SMTP_PORT ?? 587);
    const secureRaw = base.secure ?? process.env.SMTP_SECURE;
    const secure =
      secureRaw === undefined || secureRaw === null || secureRaw === ""
        ? port === 465
        : secureRaw === true || normalize(secureRaw).toLowerCase() === "true";

    const user = normalize(base.user ?? process.env.SMTP_USER);

    return {
      host: normalize(base.host ?? process.env.SMTP_HOST),
      port,
      secure,
      user,
      password: normalize(base.password ?? process.env.SMTP_PASSWORD),
      from: normalize(base.from ?? process.env.SMTP_FROM ?? process.env.SMTP_USER)
    };
  }

  return {
    isConfigured() {
      const config = readConfig();
      return Boolean(config.host && config.from);
    },

    async sendMail({ to, subject, text }) {
      const config = readConfig();

      if (!config.host) {
        throw new Error("SMTP ist nicht konfiguriert (SMTP_HOST fehlt).");
      }

      if (!to) {
        throw new Error("Kein Empfänger angegeben.");
      }

      const { default: nodemailer } = await import("nodemailer");
      const transport = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: config.user ? { user: config.user, pass: config.password } : undefined
      });

      await transport.sendMail({
        from: config.from || config.user,
        to,
        subject,
        text
      });

      logger.log?.(`E-Mail gesendet: ${subject}`);
    }
  };
}
