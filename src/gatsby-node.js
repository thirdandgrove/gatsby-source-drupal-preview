const axios = require(`axios`);
const _ = require(`lodash`);
const { createRemoteFileNode } = require(`gatsby-source-filesystem`);
const { URL } = require(`url`);
const micro = require(`micro`);
const proxy = require('http-proxy-middleware');

const { nodeFromData } = require(`./normalize`);

exports.sourceNodes = async (
  { actions, store, cache, createNodeId, createContentDigest },
  { baseUrl, apiBase, basicAuth, filters, headers, params, preview, listenPort }
) => {
  const { createNode } = actions;

  // Default apiBase to `jsonapi`
  apiBase = apiBase || `jsonapi`;

  // Touch existing Drupal nodes so Gatsby doesn't garbage collect them.
  // _.values(store.getState().nodes)
  // .filter(n => n.internal.type.slice(0, 8) === `drupal__`)
  // .forEach(n => touchNode({ nodeId: n.id }))

  // Fetch articles.
  // console.time(`fetch Drupal data`)
  console.log(`Starting to fetch data from Drupal from ${baseUrl}/${apiBase}`);

  // TODO restore this
  // let lastFetched
  // if (
  // store.getState().status.plugins &&
  // store.getState().status.plugins[`gatsby-source-drupal`]
  // ) {
  // lastFetched = store.getState().status.plugins[`gatsby-source-drupal`].status
  // .lastFetched
  // }

  const data = await axios.get(`${baseUrl}/${apiBase}`, {
    auth: basicAuth,
    headers,
    params
  });
  const allData = await Promise.all(
    _.map(data.data.links, async (url, type) => {
      if (type === `self`) return;
      if (!url) return;
      if (!type) return;
      const getNext = async (url, data = []) => {
        if (typeof url === `object`) {
          // url can be string or object containing href field
          url = url.href;

          // Apply any filters configured in gatsby-config.js. Filters
          // can be any valid JSON API filter query string.
          // See https://www.drupal.org/docs/8/modules/jsonapi/filtering
          if (typeof filters === `object`) {
            if (filters.hasOwnProperty(type)) {
              url = url + `?${filters[type]}`;
            }
          }
        }

        let d;
        try {
          d = await axios.get(url, {
            auth: basicAuth,
            headers,
            params
          });
        } catch (error) {
          if (error.response && error.response.status == 405) {
            // The endpoint doesn't support the GET method, so just skip it.
            return [];
          } else {
            console.error(`Failed to fetch ${url}`, error.message);
            console.log(error.data);
            throw error;
          }
        }
        data = data.concat(d.data.data);
        if (d.data.links.next) {
          data = await getNext(d.data.links.next, data);
        }

        return data;
      };

      const data = await getNext(url);

      const result = {
        type,
        data
      };

      // eslint-disable-next-line consistent-return
      return result;
    })
  );

  // Make list of all IDs so we can check against that when creating
  // relationships.
  const ids = {};
  _.each(allData, contentType => {
    if (!contentType) return;
    _.each(contentType.data, datum => {
      ids[datum.id] = true;
    });
  });

  // Create back references
  const backRefs = {};

  /**
   * Adds back reference to linked entity, so we can later
   * add node link.
   */
  const addBackRef = (linkedId, sourceDatum) => {
    if (ids[linkedId]) {
      if (!backRefs[linkedId]) {
        backRefs[linkedId] = [];
      }
      backRefs[linkedId].push({
        id: sourceDatum.id,
        type: sourceDatum.type
      });
    }
  };

  _.each(allData, contentType => {
    if (!contentType) return;
    _.each(contentType.data, datum => {
      if (datum.relationships) {
        _.each(datum.relationships, (v, k) => {
          if (!v.data) return;

          if (_.isArray(v.data)) {
            v.data.forEach(data => addBackRef(data.id, datum));
          } else {
            addBackRef(v.data.id, datum);
          }
        });
      }
    });
  });

  // Process nodes
  const nodes = [];
  _.each(allData, contentType => {
    if (!contentType) return;

    _.each(contentType.data, datum => {
      const node = nodeFromData(datum, createNodeId);

      node.relationships = {};

      // Add relationships
      if (datum.relationships) {
        _.each(datum.relationships, (v, k) => {
          if (!v.data) return;
          if (_.isArray(v.data) && v.data.length > 0) {
            // Create array of all ids that are in our index
            node.relationships[`${k}___NODE`] = _.compact(
              v.data.map(data => (ids[data.id] ? createNodeId(data.id) : null))
            );
          } else if (ids[v.data.id]) {
            node.relationships[`${k}___NODE`] = createNodeId(v.data.id);
          }
        });
      }

      // Add back reference relationships.
      // Back reference relationships will need to be arrays,
      // as we can't control how if node is referenced only once.
      if (backRefs[datum.id]) {
        backRefs[datum.id].forEach(ref => {
          if (!node.relationships[`${ref.type}___NODE`]) {
            node.relationships[`${ref.type}___NODE`] = [];
          }

          node.relationships[`${ref.type}___NODE`].push(createNodeId(ref.id));
        });
      }

      if (_.isEmpty(node.relationships)) {
        delete node.relationships;
      }

      node.internal.contentDigest = createContentDigest(node);
      nodes.push(node);
    });
  });

  // Download all files.
  await Promise.all(
    nodes.map(async node => {
      let fileNode;
      if (
        node.internal.type === `files` ||
        node.internal.type === `file__file`
      ) {
        try {
          let fileUrl = node.url;
          if (typeof node.uri === `object`) {
            // Support JSON API 2.x file URI format https://www.drupal.org/node/2982209
            fileUrl = node.uri.url;
          }
          // Resolve w/ baseUrl if node.uri isn't absolute.
          const url = new URL(fileUrl, baseUrl);
          // If we have basicAuth credentials, add them to the request.
          const auth =
            typeof basicAuth === `object`
              ? {
                  htaccess_user: basicAuth.username,
                  htaccess_pass: basicAuth.password
                }
              : {};
          fileNode = await createRemoteFileNode({
            url: url.href,
            store,
            cache,
            createNode,
            createNodeId,
            parentNodeId: node.id,
            auth
          });
        } catch (e) {
          // Ignore
        }
        if (fileNode) {
          node.localFile___NODE = fileNode.id;
        }
      }
    })
  );

  nodes.forEach(n => createNode(n));

  // listen for changes to nodes for preview mode
  if (process.env.NODE_ENV === 'development' && preview) {
    const server = micro(async (req, res) => {
      const request = await micro.json(req);

      const nodeToUpdate = JSON.parse(request).data;

      const node = nodeFromData(nodeToUpdate, createNodeId);
      node.relationships = {};
      // handle relationships
      if (nodeToUpdate.relationships) {
        _.each(nodeToUpdate.relationships, (value, key) => {
          if (!value.data) return;
          if (_.isArray(value.data) && value.data.length > 0) {
            value.data.forEach(data => addBackRef(data.id, nodeToUpdate));
            node.relationships[`${key}___NODE`] = _.compact(
              value.data.map(data => createNodeId(data.id))
            );
          } else {
            addBackRef(value.data.id, nodeToUpdate);
            node.relationships[`${key}___NODE`] = createNodeId(value.data.id);
          }
        });
      }
      // handle backRefs
      if (backRefs[nodeToUpdate.id]) {
        backRefs[nodeToUpdate.id].forEach(ref => {
          if (!node.relationships[`${ref.type}___NODE`]) {
            node.relationships[`${ref.type}___NODE`] = [];
          }
          node.relationships[`${ref.type}___NODE`].push(createNodeId(ref.id));
        });
      }

      // handle file downloads
      let fileNode;
      if (
        node.internal.type === `files` ||
        node.internal.type === `file__file`
      ) {
        try {
          let fileUrl = node.url;
          if (typeof node.uri === `object`) {
            // Support JSON API 2.x file URI format https://www.drupal.org/node/2982209
            fileUrl = node.uri.url;
          }
          // Resolve w/ baseUrl if node.uri isn't absolute.
          const url = new URL(fileUrl, baseUrl);
          // If we have basicAuth credentials, add them to the request.
          const auth =
            typeof basicAuth === `object`
              ? {
                  htaccess_user: basicAuth.username,
                  htaccess_pass: basicAuth.password
                }
              : {};
          fileNode = await createRemoteFileNode({
            url: url.href,
            store,
            cache,
            createNode,
            createNodeId,
            parentNodeId: node.id,
            auth
          });
        } catch (e) {
          // Ignore
        }
        if (fileNode) {
          node.localFile___NODE = fileNode.id;
        }
      }

      node.internal.contentDigest = createContentDigest(node);
      createNode(node);
      console.log('\x1b[32m', `Updated node: ${node.id}`);

      res.end('ok');
    });
    server.listen(
      8080,
      console.log(
        '\x1b[32m',
        `listening to changes for live preview at route /___updatePreview`
      )
    );
  }
};

exports.onCreateDevServer = ({ app }) => {
  app.use(
    '/___updatePreview/',
    proxy({
      target: `http://localhost:8080`,
      secure: false,
      pathRewrite: {
        '/___updatePreview/': ''
      }
    })
  );
};
