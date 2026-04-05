import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.salesfactory.messenger",
  appName: "Sales factory",
  webDir: "dist",
  server: {
    androidScheme: "https",
  },
};

export default config;
