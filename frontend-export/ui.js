// Isolierte UI-Helfer: Status-/Fehlertexte, Toast, Fokus, Busy-Zustand.
// Haengen nur an gemeinsamen DOM-Referenzen aus dom.js.
import { elements } from "./dom.js";

export function setLoginError(message = "") {
  elements.loginError.textContent = message;
  elements.loginError.classList.toggle("hidden", !message);
}

export function setRegisterError(message = "") {
  elements.registerError.textContent = message;
  elements.registerError.classList.toggle("hidden", !message);
}

export function setMasterSetupError(message = "") {
  elements.masterSetupError.textContent = message;
  elements.masterSetupError.classList.toggle("hidden", !message);
}

export function setMasterSetupSuccess(message = "") {
  elements.masterSetupSuccess.textContent = message;
  elements.masterSetupSuccess.classList.toggle("hidden", !message);
}

export function setForgotPasswordError(message = "") {
  elements.forgotPasswordError.textContent = message;
  elements.forgotPasswordError.classList.toggle("hidden", !message);
}

export function setForgotPasswordSuccess(message = "") {
  elements.forgotPasswordSuccess.textContent = message;
  elements.forgotPasswordSuccess.classList.toggle("hidden", !message);
}

export function setResetPasswordError(message = "") {
  elements.resetPasswordError.textContent = message;
  elements.resetPasswordError.classList.toggle("hidden", !message);
}

export function setResetPasswordSuccess(message = "") {
  elements.resetPasswordSuccess.textContent = message;
  elements.resetPasswordSuccess.classList.toggle("hidden", !message);
}

export function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.remove("hidden");

  clearTimeout(showToast.timeoutId);
  showToast.timeoutId = setTimeout(() => {
    elements.toast.classList.add("hidden");
  }, 3200);
}

export function focusWithoutScroll(element) {
  try {
    element?.focus({ preventScroll: true });
  } catch {
    element?.focus();
  }
}

export async function withBusyState(button, busyLabel, task) {
  if (!button) {
    return task();
  }

  const originalText = button.textContent;
  const wasDisabled = button.disabled;
  button.disabled = true;

  if (busyLabel) {
    button.textContent = busyLabel;
  }

  try {
    return await task();
  } finally {
    button.disabled = wasDisabled;
    button.textContent = originalText;
  }
}

export function setTwoFactorError(message = "") {
  elements.twoFactorError.textContent = message;
  elements.twoFactorError.classList.toggle("hidden", !message);
}

export function setTwoFactorSuccess(message = "") {
  elements.twoFactorSuccess.textContent = message;
  elements.twoFactorSuccess.classList.toggle("hidden", !message);
}

// Bestaetigungs-Dialog. confirmResolver bleibt modul-lokal (nur diese zwei Funktionen nutzen ihn).
let confirmResolver = null;

export function closeConfirmDialog(accepted) {
  elements.confirmOverlay.classList.add("hidden");
  elements.confirmOverlay.setAttribute("aria-hidden", "true");

  if (confirmResolver) {
    const resolver = confirmResolver;
    confirmResolver = null;
    resolver(Boolean(accepted));
  }
}

export function openConfirmDialog({
  eyebrow = "Bitte bestätigen",
  title = "Aktion bestätigen",
  message = "Möchten Sie fortfahren?",
  confirmLabel = "Bestätigen"
} = {}) {
  if (confirmResolver) {
    confirmResolver(false);
    confirmResolver = null;
  }

  elements.confirmEyebrow.textContent = eyebrow;
  elements.confirmTitle.textContent = title;
  elements.confirmMessage.textContent = message;
  elements.confirmAcceptButton.textContent = confirmLabel;
  elements.confirmOverlay.classList.remove("hidden");
  elements.confirmOverlay.setAttribute("aria-hidden", "false");

  return new Promise((resolve) => {
    confirmResolver = resolve;
    elements.confirmAcceptButton.focus();
  });
}
