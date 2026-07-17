ALTER TABLE appointment_availability_messages
  DROP CONSTRAINT IF EXISTS appointment_availability_messages_send_mode_check;

ALTER TABLE appointment_availability_messages
  ADD CONSTRAINT appointment_availability_messages_send_mode_check
  CHECK (send_mode IN ('booking_link', 'interactive_list', 'cta_url'));
