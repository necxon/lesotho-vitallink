-- Force MD5 password encoding so old JDBC drivers (OpenLMIS) can authenticate.
-- SET applies to this session immediately (no reload needed), so the ALTER USER
-- below stores the password as an MD5 hash instead of SCRAM-SHA-256.
SET password_encryption = 'md5';
ALTER USER admin WITH PASSWORD 'password123';
