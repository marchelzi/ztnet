import { createTRPCRouter, adminRoleProtectedRoute } from "~/server/api/trpc";
import { z } from "zod";
import * as ztController from "~/utils/ztApi";
import ejs from "ejs";
import {
	forgotPasswordTemplate,
	inviteUserTemplate,
	notificationTemplate,
} from "~/utils/mail";
import { createTransporter, sendEmail } from "~/utils/mail";
import type nodemailer from "nodemailer";
import { Role } from "@prisma/client";
import { throwError } from "~/server/helpers/errorHandler";
import { type ZTControllerNodeStatus } from "~/types/ztController";
import { NetworkAndMemberResponse } from "~/types/network";
import { execSync } from "child_process";
import fs from "fs";
import { WorldConfig } from "~/types/worldConfig";
import axios from "axios";

export const adminRouter = createTRPCRouter({
	getUsers: adminRoleProtectedRoute
		.input(
			z.object({
				isAdmin: z.boolean().default(false),
			}),
		)
		.query(async ({ ctx, input }) => {
			const users = await ctx.prisma.user.findMany({
				select: {
					id: true,
					name: true,
					email: true,
					emailVerified: true,
					lastLogin: true,
					lastseen: true,
					online: true,
					role: true,
					_count: {
						select: {
							network: true,
						},
					},
					userGroup: true,
					userGroupId: true,
				},

				where: input.isAdmin ? { role: "ADMIN" } : undefined,
			});
			return users;
		}),

	getControllerStats: adminRoleProtectedRoute.query(async ({ ctx }) => {
		try {
			const isCentral = false;
			const networks = await ztController.get_controller_networks(
				ctx,
				isCentral,
			);

			const networkCount = networks.length;
			let totalMembers = 0;
			for (const network of networks) {
				const members = await ztController.network_members(
					ctx,
					network as string,
				);
				totalMembers += Object.keys(members).length;
			}

			const controllerStatus = (await ztController.get_controller_status(
				ctx,
				isCentral,
			)) as ZTControllerNodeStatus;
			return {
				networkCount,
				totalMembers,
				controllerStatus,
			};
		} catch (error) {
			return throwError(error);
		}
	}),

	// Set global options
	getAllOptions: adminRoleProtectedRoute.query(async ({ ctx }) => {
		return await ctx.prisma.globalOptions.findFirst({
			where: {
				id: 1,
			},
		});
	}),
	// Set global options
	changeRole: adminRoleProtectedRoute
		.input(
			z.object({
				role: z
					.string()
					.refine((value) => Object.values(Role).includes(value as Role), {
						message: "Role is not valid",
						path: ["role"],
					}),
				id: z.number(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const { id, role } = input;

			if (ctx.session.user.id === id) {
				throwError("You can't change your own role");
			}

			// If the role is set to Admin, also set the userGroupId to null (i.e., delete the userGroup for the user)
			const updateData =
				role === "ADMIN"
					? {
							role: role as Role,
							userGroupId: null,
					  }
					: {
							role: role as Role,
					  };

			return await ctx.prisma.user.update({
				where: {
					id,
				},
				data: updateData,
			});
		}),
	updateGlobalOptions: adminRoleProtectedRoute
		.input(
			z.object({
				enableRegistration: z.boolean().optional(),
				firstUserRegistration: z.boolean().optional(),
				userRegistrationNotification: z.boolean().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			return await ctx.prisma.globalOptions.update({
				where: {
					id: 1,
				},
				data: {
					...input,
				},
			});
		}),
	getMailTemplates: adminRoleProtectedRoute
		.input(
			z.object({
				template: z.string(),
			}),
		)
		.query(async ({ ctx, input }) => {
			const templates = await ctx.prisma.globalOptions.findFirst({
				where: {
					id: 1,
				},
			});

			switch (input.template) {
				case "inviteUserTemplate":
					return templates?.inviteUserTemplate ?? inviteUserTemplate();
				case "forgotPasswordTemplate":
					return templates?.forgotPasswordTemplate ?? forgotPasswordTemplate();
				case "notificationTemplate":
					return templates?.notificationTemplate ?? notificationTemplate();
				default:
					return {};
			}
		}),

	setMail: adminRoleProtectedRoute
		.input(
			z.object({
				smtpHost: z.string().optional(),
				smtpPort: z.string().optional(),
				smtpSecure: z.boolean().optional(),
				smtpEmail: z.string().optional(),
				smtpPassword: z.string().optional(),
				smtpUsername: z.string().optional(),
				smtpUseSSL: z.boolean().optional(),
				smtpIgnoreTLS: z.boolean().optional(),
				smtpRequireTLS: z.boolean().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			return await ctx.prisma.globalOptions.update({
				where: {
					id: 1,
				},
				data: {
					...input,
				},
			});
		}),
	setMailTemplates: adminRoleProtectedRoute
		.input(
			z.object({
				template: z.string(),
				type: z.string(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const templateObj = JSON.parse(input.template) as string;
			switch (input.type) {
				case "inviteUserTemplate":
					return await ctx.prisma.globalOptions.update({
						where: {
							id: 1,
						},
						data: {
							inviteUserTemplate: templateObj,
						},
					});
				case "forgotPasswordTemplate":
					return await ctx.prisma.globalOptions.update({
						where: {
							id: 1,
						},
						data: {
							forgotPasswordTemplate: templateObj,
						},
					});
				case "notificationTemplate":
					return await ctx.prisma.globalOptions.update({
						where: {
							id: 1,
						},
						data: {
							notificationTemplate: templateObj,
						},
					});
				default:
					break;
			}
		}),
	getDefaultMailTemplate: adminRoleProtectedRoute
		.input(
			z.object({
				template: z.string(),
			}),
		)
		.mutation(({ input }) => {
			switch (input.template) {
				case "inviteUserTemplate":
					return inviteUserTemplate();
				case "forgotPasswordTemplate":
					return forgotPasswordTemplate();
				case "notificationTemplate":
					return notificationTemplate();
				default:
					break;
			}
		}),
	sendTestMail: adminRoleProtectedRoute
		.input(
			z.object({
				type: z.string(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const globalOptions = await ctx.prisma.globalOptions.findFirst({
				where: {
					id: 1,
				},
			});

			async function sendTemplateEmail(template) {
				const renderedTemplate = await ejs.render(
					JSON.stringify(template),
					{
						toEmail: ctx.session.user.email,
						toName: ctx.session.user.name,
						fromName: ctx.session.user.name,
						forgotLink: "https://example.com",
						notificationMessage: "Test notification message",
						nwid: "123456789",
					},
					{ async: true },
				);

				const parsedTemplate = JSON.parse(renderedTemplate) as Record<
					string,
					string
				>;

				const transporter: nodemailer.Transporter =
					createTransporter(globalOptions);

				// Define mail options
				const mailOptions = {
					from: globalOptions.smtpEmail,
					to: ctx.session.user.email,
					subject: parsedTemplate.subject,
					html: parsedTemplate.body,
				};

				// Send test mail to user
				await sendEmail(transporter, mailOptions);
			}

			switch (input.type) {
				case "inviteUserTemplate": {
					const defaultInviteTemplate = inviteUserTemplate();
					const inviteTemplate =
						globalOptions?.inviteUserTemplate ?? defaultInviteTemplate;
					await sendTemplateEmail(inviteTemplate);
					break;
				}

				case "forgotPasswordTemplate": {
					const defaultForgotTemplate = forgotPasswordTemplate();
					const forgotTemplate =
						globalOptions?.forgotPasswordTemplate ?? defaultForgotTemplate;
					await sendTemplateEmail(forgotTemplate);
					break;
				}
				case "notificationTemplate": {
					const defaultNotificationTemplate = notificationTemplate();
					const notifiyTemplate =
						globalOptions?.notificationTemplate ?? defaultNotificationTemplate;
					await sendTemplateEmail(notifiyTemplate);
					break;
				}
				default:
					break;
			}
		}),

	/**
	 * `unlinkedNetwork` is an admin protected query that fetches and returns detailed information about networks
	 * that are present in the controller but not stored in the database.
	 *
	 * First, it fetches the network IDs from the controller and from the database.
	 *
	 * It then compares these lists to find networks that exist in the controller but not in the database.
	 *
	 * For each of these unlinked networks, it fetches detailed network information from the controller.
	 *
	 * @access restricted to admins
	 * @param {Object} ctx - context object that carries important information like database instance
	 * @param {Object} input - input object that contains possible query parameters or payload
	 * @returns {Promise<NetworkAndMemberResponse[]>} - an array of unlinked network details
	 */
	unlinkedNetwork: adminRoleProtectedRoute.query(async ({ ctx }) => {
		try {
			const ztNetworks = (await ztController.get_controller_networks(
				ctx,
			)) as string[];
			const dbNetworks = await ctx.prisma.network.findMany({
				select: { nwid: true },
			});

			// create a set of nwid for faster lookup
			const dbNetworkIds = new Set(dbNetworks.map((network) => network.nwid));

			// find networks that are not in database
			const unlinkedNetworks = ztNetworks.filter(
				(networkId) => !dbNetworkIds.has(networkId),
			);

			if (unlinkedNetworks.length === 0) return [];

			const unlinkArr: NetworkAndMemberResponse[] = await Promise.all(
				unlinkedNetworks.map((unlinked) =>
					ztController.local_network_detail(ctx, unlinked, false),
				),
			);

			return unlinkArr;
		} catch (_error) {
			return throwError("Failed to fetch unlinked networks", _error);
		}
	}),
	assignNetworkToUser: adminRoleProtectedRoute
		.input(
			z.object({
				userId: z.string(),
				nwid: z.string(),
				nwname: z.string().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			try {
				// console.log(ipAssignmentPools);
				// Store the created network in the database
				const updatedUser = await ctx.prisma.user.update({
					where: {
						id: ctx.session.user.id,
					},
					data: {
						network: {
							create: {
								nwid: input.nwid,
								name: input.nwname || "",
							},
						},
					},
					select: {
						network: true,
					},
				});
				return updatedUser;

				// return ipAssignmentPools;
			} catch (err: unknown) {
				if (err instanceof Error) {
					// Log the error and throw a custom error message

					console.error(err);
					throwError("Could not create network! Please try again");
				} else {
					// Throw a generic error for unknown error types
					throwError("An unknown error occurred");
				}
			}
		}),
	addUserGroup: adminRoleProtectedRoute
		.input(
			z.object({
				id: z.number().optional(),
				groupName: z
					.string()
					.nonempty()
					.refine((val) => val.trim().length > 0, {
						message: "Group name cannot be empty",
					}),
				maxNetworks: z
					.string()
					.nonempty()
					.refine((val) => val.trim().length > 0, {
						message: "Max networks cannot be empty",
					}),
				isDefault: z
					.boolean()
					.refine((val) => typeof val !== "string", {
						message: "Default must be a boolean, not a string",
					})
					.optional()
					.refine((val) => val !== undefined, {
						message: "Default is required",
					}),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			try {
				// If isDefault is true, update all other groups to have isDefault as false
				if (input.isDefault) {
					await ctx.prisma.userGroup.updateMany({
						where: {
							isDefault: true,
						},
						data: {
							isDefault: false,
						},
					});
				}

				// Use upsert to either update or create a new userGroup
				return await ctx.prisma.userGroup.upsert({
					where: {
						id: input.id || -1, // If no ID is provided, it assumes -1 which likely doesn't exist (assuming positive autoincrementing IDs)
					},
					create: {
						name: input.groupName,
						maxNetworks: parseInt(input.maxNetworks),
						isDefault: input.isDefault,
					},
					update: {
						name: input.groupName,
						maxNetworks: parseInt(input.maxNetworks),
						isDefault: input.isDefault,
					},
				});
			} catch (err: unknown) {
				if (err instanceof Error) {
					// Log the error and throw a custom error message
					throwError(
						"Could not process user group operation! Please try again",
					);
				} else {
					// Throw a generic error for unknown error types
					throwError("An unknown error occurred");
				}
			}
		}),
	getUserGroups: adminRoleProtectedRoute.query(async ({ ctx }) => {
		const userGroups = await ctx.prisma.userGroup.findMany({
			select: {
				id: true,
				name: true,
				maxNetworks: true,
				isDefault: true,
				_count: {
					select: {
						users: true,
					},
				},
			},
		});

		return userGroups;
	}),
	deleteUserGroup: adminRoleProtectedRoute
		.input(
			z.object({
				id: z.number().refine((val) => val > 0, {
					message: "A valid group ID is required",
				}),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			try {
				// Check if the user group exists
				const existingGroup = await ctx.prisma.userGroup.findUnique({
					where: {
						id: input.id,
					},
				});

				if (!existingGroup) {
					throwError("User group not found!");
				}

				// Delete the user group
				await ctx.prisma.userGroup.delete({
					where: {
						id: input.id,
					},
				});

				return { message: "User group successfully deleted." };
			} catch (err: unknown) {
				if (err instanceof Error) {
					// Log the error and throw a custom error message
					throwError("Could not delete user group! Please try again.");
				} else {
					// Throw a generic error for unknown error types
					throwError("An unknown error occurred.");
				}
			}
		}),
	assignUserGroup: adminRoleProtectedRoute
		.input(
			z.object({
				userid: z.number(),
				userGroupId: z.string().nullable(), // Allow null value for userGroupId
			}),
		)
		.mutation(async ({ ctx, input }) => {
			if (ctx.session.user.id === input.userid) {
				throwError("You can't change your own Group");
			}
			try {
				// If "none" is selected, remove the user from the group
				if (input.userGroupId === "none") {
					return await ctx.prisma.user.update({
						where: {
							id: input.userid,
						},
						data: {
							userGroupId: null, // Remove the user's association with a userGroup
						},
					});
				}

				// Check if the user and the user group exist
				const user = await ctx.prisma.user.findUnique({
					where: {
						id: input.userid,
					},
				});

				const userGroup = await ctx.prisma.userGroup.findUnique({
					where: {
						id: parseInt(input.userGroupId),
					},
				});

				if (!user || !userGroup) {
					throw new Error("User or UserGroup not found");
				}

				// Assign the user to the user group
				return await ctx.prisma.user.update({
					where: {
						id: input.userid,
					},
					data: {
						userGroupId: parseInt(input.userGroupId), // Link the user to the userGroup
					},
				});
			} catch (err: unknown) {
				if (err instanceof Error) {
					// Log the error and throw a custom error message
					throwError(`Error assigning user to group: ${err.message}`);
				} else {
					// Throw a generic error for unknown error types
					throwError("An unknown error occurred");
				}
			}
		}),
	getIdentity: adminRoleProtectedRoute.query(async () => {
		let ip = "External IP";
		try {
			const response = await axios.get("https://api.ip.sb/ip");
			ip = response.data.trim();
		} catch (error) {
			console.error("Failed to fetch public IP:", error);
		}

		// Get identity from the file system
		const identityPath = "/var/lib/zerotier-one/identity.public";
		const identity = fs.existsSync(identityPath)
			? fs.readFileSync(identityPath, "utf-8").trim()
			: "";

		return { ip, identity };
	}),
	makeWorld: adminRoleProtectedRoute
		.input(
			z
				.object({
					plID: z.number().optional(),
					plRecommend: z.boolean().default(true),
					plBirth: z.number().optional(),
					comment: z.string().optional(),
					identity: z.string().optional(),
					endpoints: z.string(),
				})
				.refine(
					// Validator function
					(data) => {
						if (!data.plRecommend) {
							return data.plID !== null && data.plBirth !== null;
						}
						return true;
					},
					// Error message
					{
						message:
							"If plRecommend is false, both plID and plBirth need to be provided.",
						path: ["plID", "plBirth"], // Path of the fields the error refers to
					},
				)
				.refine(
					(data) => {
						if (
							data.plID === 149604618 || // official world in production ZeroTier Cloud
							data.plID === 227883110 || // reserved world for future
							data.plBirth === 1567191349589
						) {
							return false;
						}
						if (!data.plRecommend && data.plBirth <= 1567191349589) {
							return false;
						}
						return true;
					},
					{
						message:
							"Invalid Planet ID / Birth values provided. Consider using recommended values.",
						path: ["plID", "plBirth"],
					},
				),
		)

		.mutation(async ({ ctx, input }) => {
			// console.log(JSON.stringify(input, null, 2));
			// return { success: true };
			try {
				const zerotierOneDir = "/var/lib/zerotier-one";
				const mkworldDir = `${zerotierOneDir}/zt-mkworld`;
				const planetPath = `${zerotierOneDir}/planet`;
				const backupDir = `${zerotierOneDir}/planet_backup`;

				// Check for write permission on the directory
				try {
					fs.accessSync(zerotierOneDir, fs.constants.W_OK);
				} catch (_err) {
					throwError(
						`Please remove the :ro flag from the docker volume mount for ${zerotierOneDir}`,
					);
				}
				// Check if identity.public exists
				if (!fs.existsSync(`${zerotierOneDir}/identity.public`)) {
					throwError(
						"identity.public file does NOT exist, cannot generate planet file.",
					);
				}

				// Check if ztmkworld executable exists
				const ztmkworldBinPath = "/usr/local/bin/ztmkworld";
				if (!fs.existsSync(ztmkworldBinPath)) {
					throwError(
						"ztmkworld executable does not exist at the specified location.",
					);
				}
				// Ensure /var/lib/zerotier-one/zt-mkworld directory exists
				if (!fs.existsSync(mkworldDir)) {
					fs.mkdirSync(mkworldDir);
				}

				// Backup existing planet file if it exists
				if (fs.existsSync(planetPath)) {
					// we only backup the orginal planet file once
					if (!fs.existsSync(backupDir)) {
						fs.mkdirSync(backupDir);

						const timestamp = new Date()
							.toISOString()
							.replace(/[^a-zA-Z0-9]/g, "_");
						fs.copyFileSync(planetPath, `${backupDir}/planet.bak.${timestamp}`);
					}
				}
				const identity =
					input.identity ||
					fs.readFileSync(`${zerotierOneDir}/identity.public`, "utf-8").trim();

				const config: WorldConfig = {
					rootNodes: [
						{
							comments: `${input.comment || "default.domain"}`,
							identity,
							endpoints: [input.endpoints],
						},
					],
					signing: ["previous.c25519", "current.c25519"],
					output: "planet.custom",
					plID: input.plID || 0,
					plBirth: input.plBirth || 0,
					plRecommend: input.plRecommend,
				};

				fs.writeFileSync(
					`${mkworldDir}/mkworld.config.json`,
					JSON.stringify(config),
				);

				// Run ztmkworld command
				try {
					execSync(
						// "cd /etc/zt-mkworld && /usr/local/bin/ztmkworld -c /etc/zt-mkworld/mkworld.config.json",
						// use mkworldDir
						`cd ${mkworldDir} && ${ztmkworldBinPath} -c ${mkworldDir}/mkworld.config.json`,
					);
				} catch (_error) {
					throwError(
						"Could not create planet file. Please make sure your config is valid.",
					);
				}
				// Copy generated planet file
				fs.copyFileSync(
					`${mkworldDir}/planet.custom`,
					// "/var/lib/zerotier-one/planet",
					planetPath,
				);

				await ctx.prisma.globalOptions.update({
					where: {
						id: 1,
					},
					data: {
						customPlanetUsed: true,
						plBirth: config.plBirth,
						plID: config.plID,
						plEndpoints: config.rootNodes[0].endpoints[0],
						plComment: config.rootNodes[0].comments,
						plRecommend: config.plRecommend,
						plIdentity: config.rootNodes[0].identity,
					},
				});

				return config;
			} catch (err: unknown) {
				if (err instanceof Error) {
					// Log the error and throw a custom error message
					throwError(`Error assigning user to group: ${err.message}`);
				} else {
					// Throw a generic error for unknown error types
					throwError("An unknown error occurred");
				}
			}
		}),
	resetWorld: adminRoleProtectedRoute.mutation(async ({ ctx }) => {
		const zerotierOneDir = "/var/lib/zerotier-one";
		const paths = {
			backupDir: `${zerotierOneDir}/planet_backup`,
			planetPath: `${zerotierOneDir}/planet`,
			mkworldDir: `${zerotierOneDir}/zt-mkworld`,
		};

		const resetDatabase = async () => {
			await ctx.prisma.globalOptions.update({
				where: { id: 1 },
				data: {
					customPlanetUsed: false,
					plBirth: 0,
					plID: 0,
					plEndpoints: "",
					plComment: "",
					plRecommend: false,
					plIdentity: "",
				},
			});
		};

		try {
			// Ensure backup directory exists
			if (!fs.existsSync(paths.backupDir)) {
				await resetDatabase();
				throw new Error("Backup directory does not exist.");
			}

			// Get list of backup files and find the most recent
			const backups = fs
				.readdirSync(paths.backupDir)
				.filter((file) => file.startsWith("planet.bak."))
				.sort();

			if (backups.length === 0) {
				throw new Error("No backup files found.");
			}

			// Restore from the latest backup
			const latestBackup = backups.at(-1);
			fs.copyFileSync(`${paths.backupDir}/${latestBackup}`, paths.planetPath);

			// Clean up backup and mkworld directories
			fs.rmSync(paths.backupDir, { recursive: true, force: true });
			fs.rmSync(paths.mkworldDir, { recursive: true, force: true });

			await resetDatabase();
			return { success: true };
		} catch (err) {
			if (err instanceof Error) {
				throwError(`Error during reset: ${err.message}`);
			} else {
				throwError("An unknown error occurred during reset.");
			}
		}
	}),
});
