import "../src/styles.css";

export const metadata = {
  title: "Clients",
  description: "Client, admin, and developer workspace"
};

export const viewport = {
  width: "device-width",
  initialScale: 1
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
