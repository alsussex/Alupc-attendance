export const MEMBER_NOTES_MAX_LENGTH = 4_000;

export function memberContactValidation(input: {
  email?: string;
  phone?: string;
  notes?: string;
}) {
  const email = input.email?.trim() ?? "";
  const phone = input.phone?.trim() ?? "";
  const notes = input.notes ?? "";
  if (
    email &&
    (email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email))
  ) {
    return "Enter a valid email address.";
  }
  if (phone) {
    if (phone.length > 50 || !/^[\d\s()+./#-]+$/u.test(phone)) {
      return "Enter a valid phone number.";
    }
    const digitCount = phone.replace(/\D/g, "").length;
    if (digitCount < 7 || digitCount > 18) {
      return "Enter a phone number with 7 to 18 digits.";
    }
  }
  if (notes.length > MEMBER_NOTES_MAX_LENGTH) {
    return `Notes must be ${MEMBER_NOTES_MAX_LENGTH.toLocaleString()} characters or fewer.`;
  }
  return null;
}
