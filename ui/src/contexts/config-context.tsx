import { createContext, useContext, useState, useEffect } from "react";
import { Config } from "@/types/config";

interface ConfigContextType {
  config: Config | null;
  setConfig: (config: Config | null) => void;
}

const ConfigContext = createContext<ConfigContextType | null>(null);

export const useConfig = () => {
  const context = useContext(ConfigContext);
  if (!context) {
    throw new Error("useConfig must be used within a ConfigProvider");
  }
  return context;
};

export const ConfigProvider = ({
  value,
  children,
}: {
  value: Config | null;
  children: React.ReactNode;
}) => {
  const [config, setConfig] = useState<Config | null>(value);

  // Sync prop changes into local state (e.g. when RepoWrapper finishes fetching)
  useEffect(() => {
    setConfig(value);
  }, [value]);

  return (
    <ConfigContext.Provider value={{ config, setConfig }}>
      {children}
    </ConfigContext.Provider>
  );
};