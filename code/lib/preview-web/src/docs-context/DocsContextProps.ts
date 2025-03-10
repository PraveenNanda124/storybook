import type {
  Framework,
  Store_ModuleExport,
  Store_ModuleExports,
  Store_Story,
  StoryContextForLoaders,
  StoryId,
  StoryName,
} from '@storybook/types';
import type { Channel } from '@storybook/channels';
import type { StoryRenderOptions } from '../render/StoryRender';

export interface DocsContextProps<TFramework extends Framework = Framework> {
  /**
   * Register the CSF file that this docs entry represents.
   * Used by the `<Meta of={} />` block.
   */
  setMeta: (metaExports: Store_ModuleExports) => void;

  /**
   * Find a story's id from the direct export from the CSF file.
   * This is primarily used by the `<Story of={} /> block.
   */
  storyIdByModuleExport: (
    storyExport: Store_ModuleExport,
    metaExports?: Store_ModuleExports
  ) => StoryId;
  /**
   * Find a story's id from the name of the story.
   * This is primarily used by the `<Story name={} /> block.
   * Note that the story must be part of the primary CSF file of the docs entry.
   */
  storyIdByName: (storyName: StoryName) => StoryId;
  /**
   * Syncronously find a story by id (if the id is not provided, this will look up the primary
   * story in the CSF file, if such a file exists).
   */
  storyById: (id?: StoryId) => Store_Story<TFramework>;
  /**
   * Syncronously find all stories of the component referenced by the CSF file.
   */
  componentStories: () => Store_Story<TFramework>[];

  /**
   * Get the story context of the referenced story.
   */
  getStoryContext: (story: Store_Story<TFramework>) => StoryContextForLoaders<TFramework>;
  /**
   * Asyncronously load an arbitrary story by id.
   */
  loadStory: (id: StoryId) => Promise<Store_Story<TFramework>>;

  /**
   * Render a story to a given HTML element and keep it up to date across context changes
   */
  renderStoryToElement: (
    story: Store_Story<TFramework>,
    element: HTMLElement,
    options: StoryRenderOptions
  ) => () => Promise<void>;

  /**
   * Storybook channel -- use for low level event watching/emitting
   */
  channel: Channel;
}
