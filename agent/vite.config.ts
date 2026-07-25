export default {
	build: {
		target: "es2022",
		lib: {
			entry: "src/index.ts",
			formats: ["es"],
			fileName: () => "index.js",
		},
		rollupOptions: {
			output: {
				inlineDynamicImports: true,
			},
		},
	},
};
