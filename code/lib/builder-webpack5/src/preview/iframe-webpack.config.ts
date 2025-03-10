import path from 'path';
import { DefinePlugin, HotModuleReplacementPlugin, ProgressPlugin, ProvidePlugin } from 'webpack';
import type { Configuration } from 'webpack';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import CaseSensitivePathsPlugin from 'case-sensitive-paths-webpack-plugin';
import TerserWebpackPlugin from 'terser-webpack-plugin';
import VirtualModulePlugin from 'webpack-virtual-modules';
import ForkTsCheckerWebpackPlugin from 'fork-ts-checker-webpack-plugin';

import type { Options, CoreConfig, DocsOptions } from '@storybook/types';
import {
  getRendererName,
  stringifyProcessEnvs,
  handlebars,
  interpolate,
  normalizeStories,
  readTemplate,
  loadPreviewOrConfigFile,
  isPreservingSymlinks,
} from '@storybook/core-common';
import { toRequireContextString, toImportFn } from '@storybook/core-webpack';
import type { BuilderOptions, TypescriptOptions } from '../types';
import { createBabelLoader } from './babel-loader-preview';

const storybookPaths: Record<string, string> = {
  global: path.dirname(require.resolve(`global/package.json`)),
  ...[
    'addons',
    'api',
    'store',
    'channels',
    'channel-postmessage',
    'channel-websocket',
    'components',
    'core-events',
    'router',
    'theming',
    'preview-web',
    'client-api',
    'client-logger',
  ].reduce(
    (acc, sbPackage) => ({
      ...acc,
      [`@storybook/${sbPackage}`]: path.dirname(
        require.resolve(`@storybook/${sbPackage}/package.json`)
      ),
    }),
    {}
  ),
};

export default async (
  options: Options & Record<string, any> & { typescriptOptions: TypescriptOptions }
): Promise<Configuration> => {
  const {
    outputDir = path.join('.', 'public'),
    quiet,
    packageJson,
    configType,
    presets,
    previewUrl,
    babelOptions,
    typescriptOptions,
    features,
    serverChannelUrl,
  } = options;

  const frameworkOptions = await presets.apply('frameworkOptions');

  const isProd = configType === 'PRODUCTION';
  const envs = await presets.apply<Record<string, string>>('env');
  const logLevel = await presets.apply('logLevel', undefined);

  const headHtmlSnippet = await presets.apply('previewHead');
  const bodyHtmlSnippet = await presets.apply('previewBody');
  const template = await presets.apply<string>('previewMainTemplate');
  const coreOptions = await presets.apply<CoreConfig>('core');
  const builderOptions: BuilderOptions =
    typeof coreOptions.builder === 'string'
      ? {}
      : coreOptions.builder?.options || ({} as BuilderOptions);
  const docsOptions = await presets.apply<DocsOptions>('docs');

  const previewAnnotations = [
    ...(await presets.apply('previewAnnotations', [], options)),
    loadPreviewOrConfigFile(options),
  ].filter(Boolean);
  const entries = (await presets.apply('entries', [], options)) as string[];
  const workingDir = process.cwd();
  const stories = normalizeStories(await presets.apply('stories', [], options), {
    configDir: options.configDir,
    workingDir,
  });

  const virtualModuleMapping: Record<string, string> = {};
  if (features?.storyStoreV7) {
    const storiesFilename = 'storybook-stories.js';
    const storiesPath = path.resolve(path.join(workingDir, storiesFilename));

    const needPipelinedImport = !!builderOptions.lazyCompilation && !isProd;
    virtualModuleMapping[storiesPath] = toImportFn(stories, { needPipelinedImport });
    const configEntryPath = path.resolve(path.join(workingDir, 'storybook-config-entry.js'));
    virtualModuleMapping[configEntryPath] = handlebars(
      await readTemplate(
        require.resolve(
          '@storybook/builder-webpack5/templates/virtualModuleModernEntry.js.handlebars'
        )
      ),
      {
        storiesFilename,
        previewAnnotations,
      }
      // We need to double escape `\` for webpack. We may have some in windows paths
    ).replace(/\\/g, '\\\\');
    entries.push(configEntryPath);
  } else {
    const rendererName = await getRendererName(options);

    const rendererInitEntry = path.resolve(
      path.join(workingDir, 'storybook-init-renderer-entry.js')
    );
    virtualModuleMapping[rendererInitEntry] = `import '${rendererName}';`;
    entries.push(rendererInitEntry);

    const entryTemplate = await readTemplate(
      path.join(__dirname, '..', '..', 'templates', 'virtualModuleEntry.template.js')
    );

    previewAnnotations.forEach((previewAnnotationFilename: string | undefined) => {
      if (!previewAnnotationFilename) return;
      const clientApi = storybookPaths['@storybook/client-api'];
      const clientLogger = storybookPaths['@storybook/client-logger'];

      // Ensure that relative paths end up mapped to a filename in the cwd, so a later import
      // of the `previewAnnotationFilename` in the template works.
      const entryFilename = previewAnnotationFilename.startsWith('.')
        ? `${previewAnnotationFilename.replace(/(\w)(\/|\\)/g, '$1-')}-generated-config-entry.js`
        : `${previewAnnotationFilename}-generated-config-entry.js`;
      // NOTE: although this file is also from the `dist/cjs` directory, it is actually a ESM
      // file, see https://github.com/storybookjs/storybook/pull/16727#issuecomment-986485173
      virtualModuleMapping[entryFilename] = interpolate(entryTemplate, {
        previewAnnotationFilename,
        clientApi,
        clientLogger,
      });
      entries.push(entryFilename);
    });
    if (stories.length > 0) {
      const storyTemplate = await readTemplate(
        path.join(__dirname, '..', '..', 'templates', 'virtualModuleStory.template.js')
      );
      // NOTE: this file has a `.cjs` extension as it is a CJS file (from `dist/cjs`) and runs
      // in the user's webpack mode, which may be strict about the use of require/import.
      // See https://github.com/storybookjs/storybook/issues/14877
      const storiesFilename = path.resolve(path.join(workingDir, `generated-stories-entry.cjs`));
      virtualModuleMapping[storiesFilename] = interpolate(storyTemplate, {
        rendererName,
      })
        // Make sure we also replace quotes for this one
        .replace("'{{stories}}'", stories.map(toRequireContextString).join(','));
      entries.push(storiesFilename);
    }
  }

  const shouldCheckTs = typescriptOptions.check && !typescriptOptions.skipBabel;
  const tsCheckOptions = typescriptOptions.checkOptions || {};

  const cacheConfig = builderOptions.fsCache ? { cache: { type: 'filesystem' as const } } : {};
  const lazyCompilationConfig =
    builderOptions.lazyCompilation && !isProd
      ? {
          lazyCompilation: { entries: false },
        }
      : {};

  return {
    name: 'preview',
    mode: isProd ? 'production' : 'development',
    bail: isProd,
    devtool: 'cheap-module-source-map',
    entry: entries,
    output: {
      path: path.resolve(process.cwd(), outputDir),
      filename: isProd ? '[name].[contenthash:8].iframe.bundle.js' : '[name].iframe.bundle.js',
      publicPath: '',
    },
    stats: {
      preset: 'none',
      logging: 'error',
    },
    watchOptions: {
      ignored: /node_modules/,
    },
    ignoreWarnings: [
      {
        message: /export '\S+' was not found in 'global'/,
      },
    ],
    plugins: [
      Object.keys(virtualModuleMapping).length > 0
        ? new VirtualModulePlugin(virtualModuleMapping)
        : (null as any),
      new HtmlWebpackPlugin({
        filename: `iframe.html`,
        // FIXME: `none` isn't a known option
        chunksSortMode: 'none' as any,
        alwaysWriteToDisk: true,
        inject: false,
        template,
        templateParameters: {
          version: packageJson.version,
          globals: {
            CONFIG_TYPE: configType,
            LOGLEVEL: logLevel,
            FRAMEWORK_OPTIONS: frameworkOptions,
            CHANNEL_OPTIONS: coreOptions.channelOptions,
            FEATURES: features,
            PREVIEW_URL: previewUrl,
            STORIES: stories.map((specifier) => ({
              ...specifier,
              importPathMatcher: specifier.importPathMatcher.source,
            })),
            DOCS_OPTIONS: docsOptions,
            SERVER_CHANNEL_URL: serverChannelUrl,
          },
          headHtmlSnippet,
          bodyHtmlSnippet,
        },
        minify: {
          collapseWhitespace: true,
          removeComments: true,
          removeRedundantAttributes: true,
          removeScriptTypeAttributes: false,
          removeStyleLinkTypeAttributes: true,
          useShortDoctype: true,
        },
      }),
      new DefinePlugin({
        ...stringifyProcessEnvs(envs),
        NODE_ENV: JSON.stringify(process.env.NODE_ENV),
      }),
      new ProvidePlugin({ process: require.resolve('process/browser.js') }),
      isProd ? null : new HotModuleReplacementPlugin(),
      new CaseSensitivePathsPlugin(),
      quiet ? null : new ProgressPlugin({}),
      shouldCheckTs ? new ForkTsCheckerWebpackPlugin(tsCheckOptions) : null,
    ].filter(Boolean),
    module: {
      rules: [
        {
          test: /\.m?js$/,
          type: 'javascript/auto',
        },
        {
          test: /\.m?js$/,
          resolve: {
            fullySpecified: false,
          },
        },
        createBabelLoader(babelOptions, typescriptOptions),
        {
          test: /\.md$/,
          type: 'asset/source',
        },
      ],
    },
    resolve: {
      extensions: ['.mjs', '.js', '.jsx', '.ts', '.tsx', '.json', '.cjs'],
      modules: ['node_modules'].concat(envs.NODE_PATH || []),
      mainFields: ['browser', 'module', 'main'].filter(Boolean),
      alias: storybookPaths,
      fallback: {
        path: require.resolve('path-browserify'),
        assert: require.resolve('browser-assert'),
        util: require.resolve('util'),
      },
      // Set webpack to resolve symlinks based on whether the user has asked node to.
      // This feels like it should be default out-of-the-box in webpack :shrug:
      symlinks: !isPreservingSymlinks(),
    },
    optimization: {
      splitChunks: {
        chunks: 'all',
      },
      runtimeChunk: true,
      sideEffects: true,
      usedExports: isProd,
      moduleIds: 'named',
      minimizer: isProd
        ? [
            new TerserWebpackPlugin({
              parallel: true,
              terserOptions: {
                sourceMap: true,
                mangle: false,
                keep_fnames: true,
              },
            }),
          ]
        : [],
    },
    performance: {
      hints: isProd ? 'warning' : false,
    },
    ...cacheConfig,
    experiments: { ...lazyCompilationConfig },
  };
};
