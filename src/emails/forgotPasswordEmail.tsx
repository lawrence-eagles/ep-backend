import {
  Html,
  Head,
  Preview,
  Body,
  Container,
  Section,
  Text,
  Button,
  Hr,
} from "react-email";

type ForgotPasswordEmailProps = {
  userName?: string;
  resetUrl: string;
};

export default function ForgotPasswordEmail({
  resetUrl,
  userName,
}: ForgotPasswordEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Reset your password for Eaglespress</Preview>

      <Body style={main}>
        <Container style={container}>
          {/* Header */}
          <Section>
            <Text style={logo}>Eaglespress</Text>
          </Section>

          {/* Title */}
          <Section>
            <Text style={title}>Reset your password</Text>
            <Text style={paragraph}>
              {userName ? `Hi ${userName},` : "Hi,"}
            </Text>
            <Text style={paragraph}>
              We received a request to reset your password. Click the button
              below to set a new password.
            </Text>
          </Section>

          {/* Button */}
          <Section style={buttonContainer}>
            <Button href={resetUrl} style={button}>
              Reset Password
            </Button>
          </Section>

          {/* Fallback link */}
          <Section>
            <Text style={smallText}>
              If the button does not work, copy and paste this link into your
              browser:
            </Text>
            <Text style={link}>{resetUrl}</Text>
          </Section>

          <Hr style={divider} />

          {/* Footer */}
          <Section>
            <Text style={footer}>
              If you did not request this, you can safely ignore this email.
            </Text>
            <Text style={footer}>
              This link will expire for security reasons.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

/* ------------------ Styles ------------------ */

const main = {
  backgroundColor: "#f6f9fc",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
};

const container = {
  backgroundColor: "#ffffff",
  margin: "0 auto",
  padding: "32px",
  borderRadius: "12px",
  maxWidth: "480px",
};

const logo = {
  fontSize: "20px",
  fontWeight: "700",
  color: "#1877F2", // Eagles blue
  textAlign: "center" as const,
  marginBottom: "24px",
};

const title = {
  fontSize: "22px",
  fontWeight: "600",
  color: "#111827",
  marginBottom: "12px",
};

const paragraph = {
  fontSize: "14px",
  color: "#374151",
  lineHeight: "22px",
  marginBottom: "12px",
};

const buttonContainer = {
  textAlign: "center" as const,
  margin: "24px 0",
};

const button = {
  backgroundColor: "#1877F2",
  color: "#ffffff",
  padding: "12px 20px",
  borderRadius: "8px",
  textDecoration: "none",
  fontSize: "14px",
  fontWeight: "600",
};

const smallText = {
  fontSize: "12px",
  color: "#6b7280",
  marginBottom: "8px",
};

const link = {
  fontSize: "12px",
  color: "#1877F2",
  wordBreak: "break-all" as const,
};

const divider = {
  margin: "24px 0",
  borderColor: "#e5e7eb",
};

const footer = {
  fontSize: "12px",
  color: "#6b7280",
  textAlign: "center" as const,
};
