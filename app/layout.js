import "../src/styles.css";

export const metadata = {
  title: "Clients Management",
  description: "Client and request management portal"
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
