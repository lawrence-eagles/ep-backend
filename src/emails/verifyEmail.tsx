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

interface VerifyEmailProps {
  userName?: string;
  verificationUrl: string;
}

export default function VerifyEmail({
  userName = "there",
  verificationUrl,
}: VerifyEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Verify your email address</Preview>

      <Body style={main}>
        <Container style={container}>
          <Section>
            <Text style={heading}>Verify your email</Text>

            <Text style={paragraph}>Hi {userName},</Text>

            <Text style={paragraph}>
              Thanks for signing up for <strong>Eaglespress</strong>. Please
              confirm your email address by clicking the button below.
            </Text>

            <Section style={buttonContainer}>
              <Button style={button} href={verificationUrl}>
                Verify Email
              </Button>
            </Section>

            <Text style={paragraph}>
              If you did not create an account, you can safely ignore this
              email.
            </Text>

            <Hr style={hr} />

            <Text style={footer}>
              If the button doesn’t work, copy and paste this link into your
              browser:
            </Text>

            <Text style={link}>{verificationUrl}</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

/* ---------------- STYLES ---------------- */

const main = {
  backgroundColor: "#f6f9fc",
  padding: "20px 0",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif",
};

const container = {
  backgroundColor: "#ffffff",
  margin: "0 auto",
  padding: "40px",
  borderRadius: "12px",
  maxWidth: "480px",
};

const heading = {
  fontSize: "24px",
  fontWeight: "600",
  marginBottom: "20px",
};

const paragraph = {
  fontSize: "14px",
  lineHeight: "24px",
  color: "#333",
  marginBottom: "16px",
};

const buttonContainer = {
  textAlign: "center" as const,
  margin: "30px 0",
};

const button = {
  backgroundColor: "#2563eb",
  borderRadius: "8px",
  color: "#fff",
  fontSize: "14px",
  textDecoration: "none",
  padding: "12px 20px",
  display: "inline-block",
};

const hr = {
  borderColor: "#e6ebf1",
  margin: "30px 0",
};

const footer = {
  fontSize: "12px",
  color: "#8898aa",
};

const link = {
  fontSize: "12px",
  color: "#2563eb",
  wordBreak: "break-all" as const,
};
