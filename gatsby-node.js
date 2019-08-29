"use strict";

exports.sourceNodes = ({
  reporter
}) => {
  reporter.warn(`You are using a deprecated package`);
  reporter.warn(`Run 'yarn remove gatsby-source-drupal-preview'`);
  reporter.warn(`Then Run 'yarn add gatsby-source-drupal'`);
};