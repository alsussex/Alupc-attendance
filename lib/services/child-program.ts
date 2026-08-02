export interface ChildProgramCopy {
  label: "Sunday School Kids" | "Children’s Church";
  helperText: string;
}

export function childProgramForService(
  serviceType: string | undefined,
): ChildProgramCopy | null {
  if (
    serviceType === "Sunday Morning" ||
    serviceType === "Special Service"
  ) {
    return {
      label: "Sunday School Kids",
      helperText: "Children attending Sunday School without recorded names.",
    };
  }
  if (serviceType === "Wednesday Bible Study") {
    return {
      label: "Children’s Church",
      helperText:
        "Children attending Children’s Church without recorded names.",
    };
  }
  return null;
}
