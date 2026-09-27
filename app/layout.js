import "../src/styles.css";

export const metadata = {
  title: "Clients",
  description: "Client, admin, and developer workspace"
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
