import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from "react-email";

interface DeleteAccountEmailProps {
  userName: string;
  verificationUrl: string;
  token: string;
}

export default function DeleteAccountEmail({
  userName,
  verificationUrl,
}: DeleteAccountEmailProps) {
  return (
    <Html>
      <Head />

      <Preview>Confirm your Eaglespress account deletion</Preview>

      <Body
        style={{
          margin: 0,
          padding: "40px 20px",
          backgroundColor: "#f6f7f9",
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        }}
      >
        <Container
          style={{
            maxWidth: "520px",
            margin: "0 auto",
            backgroundColor: "#ffffff",
            borderRadius: "16px",
            padding: "40px",
          }}
        >
          {/* Logo / Brand */}
          <Section>
            <Text
              style={{
                margin: 0,
                fontSize: "24px",
                fontWeight: "700",
                color: "#1877F2",
                letterSpacing: "-0.5px",
              }}
            >
              Eaglespress
            </Text>
          </Section>

          {/* Heading */}
          <Section style={{ marginTop: "36px" }}>
            <Heading
              style={{
                margin: 0,
                fontSize: "28px",
                lineHeight: "36px",
                fontWeight: "700",
                color: "#111827",
                letterSpacing: "-0.6px",
              }}
            >
              Confirm account deletion
            </Heading>

            <Text
              style={{
                margin: "20px 0 0",
                fontSize: "16px",
                lineHeight: "26px",
                color: "#4b5563",
              }}
            >
              Hi {userName},
            </Text>

            <Text
              style={{
                margin: "16px 0 0",
                fontSize: "16px",
                lineHeight: "26px",
                color: "#4b5563",
              }}
            >
              We received a request to permanently delete your Eaglespress
              account.
            </Text>

            <Text
              style={{
                margin: "16px 0 0",
                fontSize: "16px",
                lineHeight: "26px",
                color: "#4b5563",
              }}
            >
              If you made this request, click the button below to confirm the
              deletion of your account.
            </Text>
          </Section>

          {/* Confirmation Button */}
          <Section style={{ marginTop: "32px", textAlign: "center" }}>
            <Button
              href={verificationUrl}
              style={{
                display: "inline-block",
                backgroundColor: "#dc2626",
                color: "#ffffff",
                padding: "14px 24px",
                borderRadius: "10px",
                fontSize: "15px",
                fontWeight: "600",
                textDecoration: "none",
              }}
            >
              Delete My Account
            </Button>
          </Section>

          {/* Warning */}
          <Section
            style={{
              marginTop: "28px",
              padding: "16px",
              backgroundColor: "#fef2f2",
              borderRadius: "10px",
            }}
          >
            <Text
              style={{
                margin: 0,
                fontSize: "14px",
                lineHeight: "22px",
                color: "#991b1b",
              }}
            >
              <strong>This action is permanent.</strong> Once your account is
              deleted, your account data cannot be recovered.
            </Text>
          </Section>

          {/* Security Notice */}
          <Section style={{ marginTop: "28px" }}>
            <Text
              style={{
                margin: 0,
                fontSize: "14px",
                lineHeight: "22px",
                color: "#6b7280",
              }}
            >
              If you did not request this, you can safely ignore this email.
              Your account will remain active.
            </Text>
          </Section>

          <Hr
            style={{
              margin: "32px 0",
              border: 0,
              borderTop: "1px solid #e5e7eb",
            }}
          />

          {/* Footer */}
          <Section>
            <Text
              style={{
                margin: 0,
                fontSize: "13px",
                lineHeight: "20px",
                color: "#9ca3af",
              }}
            >
              This is an automated security email from Eaglespress. Please do
              not reply to this email.
            </Text>

            <Text
              style={{
                margin: "8px 0 0",
                fontSize: "13px",
                color: "#9ca3af",
              }}
            >
              © {new Date().getFullYear()} Eaglespress
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
