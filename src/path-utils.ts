import { normalizePath } from "obsidian";

/**
 * Normalizes and resolves a file path into a portable cloud-relative or vault-relative URI.
 * This prevents broken absolute paths (like C:\Users\donal\...) when syncing via
 * Google Drive across different machines, laptops, or operating systems.
 */
export function resolvePortableResourceUri(
	filePath: string,
	vaultBasePath?: string,
	customCloudRoot?: string
): string {
	if (!filePath) return "";

	// If already a web URL, return as-is
	if (/^https?:\/\//i.test(filePath)) {
		return filePath;
	}

	// Normalize slashes to forward slashes
	let cleanPath = filePath.replace(/\\/g, "/");

	// 1. If path is inside the vault directory: use bundle-relative path or vault-relative URI
	if (vaultBasePath) {
		const normVault = vaultBasePath.replace(/\\/g, "/").replace(/\/+$/, "");
		if (cleanPath.startsWith(normVault)) {
			const relVault = cleanPath.slice(normVault.length).replace(/^\/+/, "");
			return `/${relVault}`;
		}
	}

	// 2. If a custom cloud root is configured in Lattice settings:
	if (customCloudRoot) {
		const normCloud = customCloudRoot.replace(/\\/g, "/").replace(/\/+$/, "");
		if (cleanPath.startsWith(normCloud)) {
			const relCloud = cleanPath.slice(normCloud.length).replace(/^\/+/, "");
			return `gdrive://${encodeURI(relCloud)}`;
		}
	}

	// 3. Auto-detect Google Drive / OneDrive root in path
	// e.g. "C:/Users/.../My Drive/..." or "C:/Users/.../Google Drive/..."
	const cloudDriveRegex = /^(?:.*[/\\])?(My Drive|Google Drive|OneDrive)[/\\](.*)$/i;
	const match = filePath.match(cloudDriveRegex);
	if (match) {
		const driveName = match[1];
		const relCloudPath = match[2].replace(/\\/g, "/");
		const scheme = driveName.toLowerCase().includes("onedrive") ? "onedrive" : "gdrive";
		return `${scheme}://${encodeURI(relCloudPath)}`;
	}

	// 4. Fallback to standard URL-encoded file:/// URI
	const winDriveMatch = cleanPath.match(/^([a-zA-Z]):\/(.*)$/);
	if (winDriveMatch) {
		return `file:///${winDriveMatch[1].toUpperCase()}:/${encodeURI(winDriveMatch[2])}`;
	}

	return `file://${encodeURI(cleanPath.startsWith("/") ? cleanPath : "/" + cleanPath)}`;
}

/**
 * Formats a clean kebab-case slug for filenames.
 */
export function toKebabSlug(text: string): string {
	return text
		.toLowerCase()
		.trim()
		.replace(/['’]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
}
